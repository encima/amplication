import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { drizzle } from 'drizzle-orm/postgres-js';
import { HttpsProxyAgent } from 'https-proxy-agent';
import postgres from 'postgres';
import WebSocket from 'ws';
import type { TargetEnv } from '../scripts/env';

export type Status = 'pass' | 'fail' | 'skip';
export interface CheckResult {
  name: string;
  status: Status;
  ms: number;
  detail?: unknown;
  error?: string;
}

export const RT_WAIT_MS = Number(process.env.RT_WAIT_MS ?? 10_000);

// Node's WebSocket ignores HTTPS_PROXY; route realtime through it when one is set.
const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy;
const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
class ProxiedWebSocket extends WebSocket {
  constructor(address: string, protocols?: string | string[]) {
    const local = /^wss?:\/\/(127\.0\.0\.1|localhost)/.test(address);
    super(address, protocols, proxyAgent && !local ? { agent: proxyAgent } : {});
  }
}

export interface TestUser {
  label: string;
  id: string;
  email?: string;
  password?: string;
  token: string;
  client: SupabaseClient;
}

export interface Ctx {
  target: TargetEnv;
  stamp: string;
  admin: SupabaseClient;
  anon: SupabaseClient;
  users: { a?: TestUser; b?: TestUser; anonymous?: TestUser };
  sql?: postgres.Sql;
  db?: ReturnType<typeof drizzle>;
  links: { aPrivate?: number; aPublic?: number; bPublic?: number };
  cleanup: Array<() => Promise<unknown>>;
}

export function newClient(t: TargetEnv, key: string): SupabaseClient {
  return createClient(t.url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: ProxiedWebSocket as never },
  });
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) {
    const x = e as Error & { code?: string; cause?: unknown };
    const cause = x.cause instanceof Error ? ` (cause: ${x.cause.message})` : '';
    return `${x.code ? `[${x.code}] ` : ''}${e.message}${cause}`;
  }
  if (e && typeof e === 'object' && 'message' in e) {
    const x = e as { message: string; code?: string };
    return `${x.code ? `[${x.code}] ` : ''}${x.message}`;
  }
  return String(e);
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, rej) => (timer = setTimeout(() => rej(new Error(`timeout after ${ms}ms: ${label}`)), ms))),
  ]);
}

export async function waitFor<T>(get: () => T | undefined | Promise<T | undefined>, ms: number): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await get();
    if (v) return v;
    await sleep(200);
  }
  return undefined;
}

export function subscribe(channel: RealtimeChannel, ms = 15_000): Promise<void> {
  return withTimeout(
    new Promise((resolve, reject) => {
      channel.subscribe((status, err) => {
        if (status === 'SUBSCRIBED') resolve();
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED')
          reject(new Error(`channel ${status}${err ? `: ${err.message}` : ''}`));
      });
    }),
    ms,
    `subscribe ${channel.topic}`,
  );
}

/** Throw on a supabase-js `{ error }` result, otherwise return data. */
export function ok<R extends { data: unknown; error: unknown }>(res: R): NonNullable<Extract<R, { error: null }>['data']> {
  if (res.error) throw res.error;
  return res.data as NonNullable<Extract<R, { error: null }>['data']>;
}

export class Runner {
  results: CheckResult[] = [];

  async check(name: string, fn: () => Promise<unknown>, opts: { needs?: unknown[]; timeoutMs?: number } = {}) {
    if (opts.needs?.some((n) => !n)) return this.skip(name, 'prerequisite failed');
    const start = Date.now();
    try {
      const detail = await withTimeout(fn(), opts.timeoutMs ?? 30_000, name);
      this.results.push({ name, status: 'pass', ms: Date.now() - start, detail });
      console.log(`  ✓ ${name}`);
      return true;
    } catch (e) {
      this.results.push({ name, status: 'fail', ms: Date.now() - start, error: errMsg(e) });
      console.log(`  ✗ ${name}: ${errMsg(e)}`);
      return false;
    }
  }

  skip(name: string, reason: string) {
    this.results.push({ name, status: 'skip', ms: 0, error: reason });
    console.log(`  - ${name}: skipped (${reason})`);
    return false;
  }
}
