import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createClient, type SupabaseClient, type RealtimeChannel } from '@supabase/supabase-js';
import { eq, sql } from 'drizzle-orm';
import { drizzle as drizzlePgJs } from 'drizzle-orm/postgres-js';
import { migrate as migratePgJs } from 'drizzle-orm/postgres-js/migrator';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import { migrate as migrateNodePg } from 'drizzle-orm/node-postgres/migrator';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import pg from 'pg';
import postgres from 'postgres';
import WebSocket from 'ws';
import { todos } from './schema';

type Status = 'pass' | 'fail' | 'skip';
interface CheckResult {
  name: string;
  status: Status;
  ms: number;
  detail?: unknown;
  error?: string;
}
interface Target {
  name: string;
  url: string;
  publishableKey: string;
  secretKey: string;
  databaseUrl: string;
}

const MIGRATIONS_SCHEMA = 'drizzle';
const MIGRATIONS_TABLE = '__compat_migrations';
const RT_WAIT_MS = Number(process.env.RT_WAIT_MS ?? 10_000);
const DRIVER = process.env.PG_DRIVER ?? 'postgres-js';

// Node's WebSocket/fetch ignore HTTPS_PROXY; route realtime through it when set.
const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy;
const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
class ProxiedWebSocket extends WebSocket {
  constructor(address: string, protocols?: string | string[]) {
    super(address, protocols, proxyAgent ? { agent: proxyAgent } : {});
  }
}

const ALL_TARGETS = ['MULTIGRES', 'NORMAL'];

function loadTargets(): Target[] {
  const only = process.env.TARGETS?.split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const unknown = only?.filter((n) => !ALL_TARGETS.includes(n)) ?? [];
  if (unknown.length) throw new Error(`Unknown TARGETS: ${unknown.join(', ')} (expected ${ALL_TARGETS.join(', ')})`);

  const targets = ALL_TARGETS.filter((n) => !only || only.includes(n)).map((n) => ({
    name: n.toLowerCase(),
    url: process.env[`${n}_URL`] ?? '',
    publishableKey: process.env[`${n}_PUBLISHABLE_KEY`] ?? '',
    secretKey: process.env[`${n}_SECRET_KEY`] ?? '',
    databaseUrl: process.env[`${n}_DATABASE_URL`] ?? '',
  }));

  // Fail loudly rather than silently dropping a project with incomplete config.
  const missing = targets.flatMap((t) => {
    const n = t.name.toUpperCase();
    return [
      !t.url && `${n}_URL`,
      !t.publishableKey && `${n}_PUBLISHABLE_KEY`,
      !t.secretKey && `${n}_SECRET_KEY`,
    ].filter(Boolean) as string[];
  });
  if (missing.length) throw new Error(`Missing env vars (check .env in ${process.cwd()}): ${missing.join(', ')}`);

  if (only) console.log(`TARGETS=${process.env.TARGETS} → running: ${targets.map((t) => t.name).join(', ')}`);
  for (const t of targets)
    if (!t.databaseUrl) console.log(`warning: ${t.name.toUpperCase()}_DATABASE_URL not set, DB checks will be skipped`);
  return targets;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms: ${label}`)), ms)),
  ]);
}

function errMsg(e: unknown): string {
  if (e instanceof Error) {
    const anyE = e as Error & { code?: string; cause?: unknown };
    const cause = anyE.cause instanceof Error ? ` (cause: ${anyE.cause.message})` : '';
    return `${anyE.code ? `[${anyE.code}] ` : ''}${e.message}${cause}`;
  }
  return typeof e === 'object' ? JSON.stringify(e) : String(e);
}

class Runner {
  results: CheckResult[] = [];
  constructor(public target: Target) {}

  async check(name: string, fn: () => Promise<unknown>, timeoutMs = 30_000): Promise<boolean> {
    const start = Date.now();
    try {
      const detail = await withTimeout(fn(), timeoutMs, name);
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
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// Drizzle client over the chosen driver. prepare:false keeps postgres-js usable behind
// transaction poolers; the dedicated prepared-statement check opts back in.
function makeDb(url: string) {
  if (DRIVER === 'node-postgres') {
    const pool = new pg.Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 15_000 });
    return {
      db: drizzleNodePg(pool) as unknown as ReturnType<typeof drizzlePgJs>,
      migrate: (db: unknown) =>
        migrateNodePg(db as ReturnType<typeof drizzleNodePg>, {
          migrationsFolder: './drizzle',
          migrationsSchema: MIGRATIONS_SCHEMA,
          migrationsTable: MIGRATIONS_TABLE,
        }),
      close: () => pool.end(),
    };
  }
  const client = postgres(url, { max: 3, connect_timeout: 15, prepare: false, onnotice: () => {} });
  return {
    db: drizzlePgJs(client),
    migrate: (db: unknown) =>
      migratePgJs(db as ReturnType<typeof drizzlePgJs>, {
        migrationsFolder: './drizzle',
        migrationsSchema: MIGRATIONS_SCHEMA,
        migrationsTable: MIGRATIONS_TABLE,
      }),
    close: () => client.end({ timeout: 5 }),
  };
}

// Both drivers expose the same query builder; type against postgres-js for simplicity.
type Db = ReturnType<typeof drizzlePgJs>;

// Run fn as an authenticated user the way PostgREST does: role + request.jwt.claims.
async function asUser<T>(db: Db, claims: Record<string, unknown>, fn: (tx: Db) => Promise<T>): Promise<T> {
  return (db as any).transaction(async (tx: Db) => {
    await tx.execute(sql`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`);
    await tx.execute(sql`set local role authenticated`);
    return fn(tx);
  });
}

function rows(res: any): any[] {
  return Array.isArray(res) ? res : res.rows;
}

async function waitFor<T>(arr: T[], pred: (x: T) => boolean, ms: number): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = arr.find(pred);
    if (hit) return hit;
    await sleep(100);
  }
  return undefined;
}

function subscribe(channel: RealtimeChannel): Promise<void> {
  return new Promise((resolve, reject) => {
    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') resolve();
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED')
        reject(new Error(`channel ${status}${err ? `: ${err.message}` : ''}`));
    });
  });
}

async function runTarget(t: Target): Promise<CheckResult[]> {
  console.log(`\n=== ${t.name} (${t.url}) driver=${DRIVER}`);
  const r = new Runner(t);
  const clientOpts = {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: ProxiedWebSocket as any },
  };
  const admin = createClient(t.url, t.secretKey, clientOpts);
  const stamp = `${Date.now()}`;
  const users = [0, 1].map((i) => ({
    email: `compat-${t.name}-${stamp}-${i}@example.com`,
    password: `Compat-${stamp}-pw!${i}`,
    id: '',
    client: createClient(t.url, t.publishableKey, clientOpts) as SupabaseClient,
    token: '',
  }));
  const cleanup: Array<() => Promise<unknown>> = [];

  // ---------- Auth ----------
  await r.check('auth.health', async () => {
    const res = await fetch(`${t.url}/auth/v1/health`, { headers: { apikey: t.publishableKey } });
    const body = await res.json();
    assert(res.ok, `HTTP ${res.status} ${JSON.stringify(body)}`);
    return { version: body.version, name: body.name };
  });

  await r.check('auth.settings', async () => {
    const res = await fetch(`${t.url}/auth/v1/settings`, { headers: { apikey: t.publishableKey } });
    const body = await res.json();
    assert(res.ok, `HTTP ${res.status}`);
    return {
      disable_signup: body.disable_signup,
      mailer_autoconfirm: body.mailer_autoconfirm,
      anonymous_users: body.external?.anonymous_users,
      email: body.external?.email,
    };
  });

  const usersOk = await r.check('auth.admin.createUser', async () => {
    for (const u of users) {
      const { data, error } = await admin.auth.admin.createUser({
        email: u.email,
        password: u.password,
        email_confirm: true,
      });
      if (error) throw error;
      u.id = data.user.id;
      cleanup.push(() => admin.auth.admin.deleteUser(u.id));
    }
    return users.map((u) => u.id);
  });

  const signedIn =
    usersOk &&
    (await r.check('auth.signInWithPassword', async () => {
      for (const u of users) {
        const { data, error } = await u.client.auth.signInWithPassword({ email: u.email, password: u.password });
        if (error) throw error;
        u.token = data.session.access_token;
      }
      return { expires_in: (await users[0].client.auth.getSession()).data.session?.expires_in };
    }));

  if (signedIn) {
    await r.check('auth.jwks.verify', async () => {
      const header = decodeProtectedHeader(users[0].token);
      const jwks = createRemoteJWKSet(new URL(`${t.url}/auth/v1/.well-known/jwks.json`));
      const { payload } = await jwtVerify(users[0].token, jwks, { issuer: `${t.url}/auth/v1` });
      assert(payload.sub === users[0].id, 'sub mismatch');
      return { alg: header.alg, kid: header.kid, role: payload.role, aud: payload.aud, iss: payload.iss };
    });
    await r.check('auth.getClaims', async () => {
      const { data, error } = await users[0].client.auth.getClaims();
      if (error) throw error;
      assert(data?.claims.sub === users[0].id, 'sub mismatch');
      return { role: data?.claims.role, aal: data?.claims.aal };
    });
    await r.check('auth.getUser', async () => {
      const { data, error } = await users[0].client.auth.getUser();
      if (error) throw error;
      assert(data.user.email === users[0].email, 'email mismatch');
    });
    await r.check('auth.refreshSession', async () => {
      const { data, error } = await users[0].client.auth.refreshSession();
      if (error) throw error;
      users[0].token = data.session!.access_token;
    });
  } else {
    for (const n of ['auth.jwks.verify', 'auth.getClaims', 'auth.getUser', 'auth.refreshSession'])
      r.skip(n, 'no signed-in user');
  }

  await r.check('auth.signInAnonymously', async () => {
    const c = createClient(t.url, t.publishableKey, clientOpts);
    const { data, error } = await c.auth.signInAnonymously();
    if (error) throw error;
    cleanup.push(() => admin.auth.admin.deleteUser(data.user!.id));
    return { is_anonymous: data.user?.is_anonymous };
  });

  // ---------- Realtime (no DB needed) ----------
  await r.check('realtime.broadcast', async () => {
    const topic = `compat-bc-${stamp}`;
    const got: any[] = [];
    const a = admin.channel(topic, { config: { broadcast: { self: false } } });
    const b = createClient(t.url, t.publishableKey, clientOpts).channel(topic);
    b.on('broadcast', { event: 'ping' }, (m) => got.push(m));
    await subscribe(b);
    await subscribe(a);
    cleanup.push(() => Promise.all([a.unsubscribe(), b.unsubscribe()]));
    const sendStatus = await a.send({ type: 'broadcast', event: 'ping', payload: { n: 1 } });
    const hit = await waitFor(got, () => true, RT_WAIT_MS);
    assert(hit, `no broadcast received (send status=${sendStatus})`);
    return { sendStatus };
  });

  await r.check('realtime.broadcast.httpSend', async () => {
    const topic = `compat-bchttp-${stamp}`;
    const got: any[] = [];
    const b = createClient(t.url, t.publishableKey, clientOpts).channel(topic);
    b.on('broadcast', { event: 'ping' }, (m) => got.push(m));
    await subscribe(b);
    cleanup.push(() => b.unsubscribe());
    const res = await fetch(`${t.url}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: { apikey: t.secretKey, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ topic, event: 'ping', payload: { n: 2 } }] }),
    });
    assert(res.ok, `HTTP ${res.status} ${await res.text()}`);
    assert(await waitFor(got, () => true, RT_WAIT_MS), 'no broadcast received');
  });

  await r.check('realtime.presence', async () => {
    const topic = `compat-pr-${stamp}`;
    const a = admin.channel(topic, { config: { presence: { key: 'a' } } });
    const states: any[] = [];
    a.on('presence', { event: 'sync' }, () => states.push(a.presenceState()));
    await subscribe(a);
    cleanup.push(() => a.unsubscribe());
    await a.track({ online_at: new Date().toISOString() });
    const hit = await waitFor(states, (s) => Object.keys(s).includes('a'), RT_WAIT_MS);
    assert(hit, 'presence state never contained tracked key');
  });

  // ---------- Database via Drizzle ----------
  const dbCheckNames = [
    'db.connect',
    'db.migrate',
    'db.schema.rlsEnabled',
    'db.schema.policies',
    'db.schema.publication',
    'db.preparedStatements',
    'db.rls.ownRows',
    'db.rls.blockForeignInsert',
    'db.rls.anonSeesNothing',
    'db.drizzleKit.pull',
    'rest.insertOwn',
    'rest.selectIsolation',
    'rest.crossUserUpdateBlocked',
    'rest.anonSeesNothing',
    'realtime.postgresChanges.insert',
    'realtime.postgresChanges.rlsFiltered',
    'realtime.postgresChanges.update',
    'realtime.postgresChanges.delete',
  ];
  if (!t.databaseUrl) {
    dbCheckNames.forEach((n) => r.skip(n, 'no DATABASE_URL'));
    await runCleanup(cleanup);
    return r.results;
  }

  const { db, migrate, close } = makeDb(t.databaseUrl);
  const connected = await r.check(
    'db.connect',
    async () => {
      const res = rows(
        await db.execute(sql`select version() as version, current_user as user,
          current_setting('server_version') as server_version,
          current_setting('ssl', true) as ssl, inet_server_addr()::text as addr`),
      );
      return res[0];
    },
    25_000,
  );
  if (!connected) {
    dbCheckNames.slice(1).forEach((n) => r.skip(n, 'db.connect failed'));
    await close().catch(() => {});
    await runCleanup(cleanup);
    return r.results;
  }

  // Fresh slate so repeated runs exercise the full migration path.
  await db.execute(sql`drop table if exists public.compat_todos cascade`).catch(() => {});
  await db.execute(sql.raw(`drop table if exists "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"`)).catch(() => {});

  const migrated = await r.check('db.migrate', async () => {
    await migrate(db);
    cleanup.unshift(async () => {
      await db.execute(sql`drop table if exists public.compat_todos cascade`);
      await db.execute(sql.raw(`drop table if exists "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"`));
    });
    // Ask PostgREST to pick up the new table straight away.
    await db.execute(sql`notify pgrst, 'reload schema'`);
  });

  if (migrated) {
    await r.check('db.schema.rlsEnabled', async () => {
      const res = rows(
        await db.execute(
          sql`select relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.compat_todos'::regclass`,
        ),
      );
      assert(res[0]?.relrowsecurity === true, `relrowsecurity=${res[0]?.relrowsecurity}`);
      return res[0];
    });
    await r.check('db.schema.policies', async () => {
      const res = rows(
        await db.execute(
          sql`select policyname, cmd, roles::text as roles from pg_policies where tablename = 'compat_todos' order by policyname`,
        ),
      );
      assert(res.length === 4, `expected 4 policies, got ${res.length}`);
      return res;
    });
    await r.check('db.schema.publication', async () => {
      const res = rows(
        await db.execute(
          sql`select pubname from pg_publication_tables where tablename = 'compat_todos' and schemaname = 'public'`,
        ),
      );
      assert(
        res.some((x: any) => x.pubname === 'supabase_realtime'),
        'not in supabase_realtime publication',
      );
      return res;
    });
  } else {
    ['db.schema.rlsEnabled', 'db.schema.policies', 'db.schema.publication'].forEach((n) =>
      r.skip(n, 'db.migrate failed'),
    );
  }

  await r.check('db.preparedStatements', async () => {
    // Named, server-side prepared statements (drizzle .prepare()) executed repeatedly.
    let prepDb: any;
    let end: () => Promise<unknown>;
    if (DRIVER === 'node-postgres') {
      const pool = new pg.Pool({ connectionString: t.databaseUrl, max: 1 });
      prepDb = drizzleNodePg(pool);
      end = () => pool.end();
    } else {
      const c = postgres(t.databaseUrl, { max: 1, prepare: true, onnotice: () => {} });
      prepDb = drizzlePgJs(c);
      end = () => c.end({ timeout: 5 });
    }
    try {
      const q = prepDb
        .select({ n: sql<number>`${sql.placeholder('n')}::int + 1` })
        .from(sql`(select 1) s`)
        .prepare('compat_prepared');
      const out = [];
      for (let i = 0; i < 5; i++) out.push((await q.execute({ n: i }))[0].n);
      assert(out.join(',') === '1,2,3,4,5', `unexpected ${out}`);
    } finally {
      await end();
    }
  });

  const haveTableAndUsers = migrated && signedIn;
  if (haveTableAndUsers) {
    const claimsFor = (u: (typeof users)[number]) => ({ sub: u.id, role: 'authenticated' });

    await r.check('db.rls.ownRows', async () => {
      await asUser(db, claimsFor(users[0]), (tx) => tx.insert(todos).values({ title: 'drizzle-a' }));
      await asUser(db, claimsFor(users[1]), (tx) => tx.insert(todos).values({ title: 'drizzle-b' }));
      const seenByA = await asUser(db, claimsFor(users[0]), (tx) => tx.select().from(todos));
      assert(seenByA.length === 1 && seenByA[0].userId === users[0].id, `A saw ${JSON.stringify(seenByA)}`);
      const total = rows(await db.execute(sql`select count(*)::int as c from public.compat_todos`))[0].c;
      assert(total === 2, `superuser sees ${total} rows, expected 2`);
      return { seenByA: seenByA.length, total };
    });

    await r.check('db.rls.blockForeignInsert', async () => {
      try {
        await asUser(db, claimsFor(users[0]), (tx) =>
          tx.insert(todos).values({ title: 'spoof', userId: users[1].id }),
        );
      } catch (e: any) {
        const code = e.code ?? e.cause?.code;
        assert(code === '42501', `expected 42501, got ${code}: ${errMsg(e)}`);
        return { code };
      }
      throw new Error('insert for another user was allowed');
    });

    await r.check('db.rls.anonSeesNothing', async () => {
      const res = await (db as any).transaction(async (tx: Db) => {
        await tx.execute(sql`set local role anon`);
        return rows(await tx.execute(sql`select * from public.compat_todos`));
      });
      assert(res.length === 0, `anon saw ${res.length} rows`);
    });
  } else {
    ['db.rls.ownRows', 'db.rls.blockForeignInsert', 'db.rls.anonSeesNothing'].forEach((n) =>
      r.skip(n, 'needs migrated table and signed-in users'),
    );
  }

  await r.check(
    'db.drizzleKit.pull',
    async () => {
      const out = spawnSync('npx', ['drizzle-kit', 'pull', '--out', `./reports/pull-${t.name}`], {
        env: { ...process.env, TARGET: t.name.toUpperCase() },
        encoding: 'utf8',
        timeout: 90_000,
      });
      const log = `${out.stdout}\n${out.stderr}`.trim();
      assert(out.status === 0 && !/error/i.test(out.stderr ?? ''), log.slice(-800));
      return log.split('\n').slice(-3).join(' | ');
    },
    100_000,
  );

  // ---------- PostgREST + Realtime postgres_changes ----------
  if (haveTableAndUsers) {
    // Realtime subscriber for user A, authorised with A's JWT so RLS applies.
    const events: any[] = [];
    const chan = users[0].client.channel(`compat-pg-${stamp}`);
    let rtReady = false;
    try {
      users[0].client.realtime.setAuth(users[0].token);
      chan.on('postgres_changes', { event: '*', schema: 'public', table: 'compat_todos' }, (p) => events.push(p));
      await withTimeout(subscribe(chan), 15_000, 'postgres_changes subscribe');
      cleanup.push(() => chan.unsubscribe());
      rtReady = true;
      await sleep(1500); // let the replication slot / subscription settle
    } catch (e) {
      r.results.push({ name: 'realtime.postgresChanges.subscribe', status: 'fail', ms: 0, error: errMsg(e) });
      console.log(`  ✗ realtime.postgresChanges.subscribe: ${errMsg(e)}`);
    }

    await sleep(1000); // PostgREST schema reload
    let ownRowId: number | undefined;
    await r.check('rest.insertOwn', async () => {
      for (const [i, u] of users.entries()) {
        const { data, error } = await u.client
          .from('compat_todos')
          .insert({ title: `rest-${i}` })
          .select()
          .single();
        if (error) throw error;
        assert(data.user_id === u.id, 'user_id default auth.uid() not applied');
        if (i === 0) ownRowId = data.id;
      }
    });

    await r.check('rest.selectIsolation', async () => {
      const { data, error } = await users[0].client.from('compat_todos').select('*');
      if (error) throw error;
      assert(
        data.every((x) => x.user_id === users[0].id),
        `A saw foreign rows: ${JSON.stringify(data)}`,
      );
      return { rowsVisibleToA: data.length };
    });

    await r.check('rest.crossUserUpdateBlocked', async () => {
      const { data, error } = await users[1].client
        .from('compat_todos')
        .update({ title: 'hijack' })
        .eq('id', ownRowId!)
        .select();
      if (error) throw error;
      assert(data.length === 0, 'B updated A row');
    });

    await r.check('rest.anonSeesNothing', async () => {
      const anon = createClient(t.url, t.publishableKey, clientOpts);
      const { data, error } = await anon.from('compat_todos').select('*');
      if (error) return { error: error.message, code: error.code }; // permission denied is also acceptable
      assert(data.length === 0, `anon saw ${data.length}`);
      return { rows: 0 };
    });

    if (rtReady) {
      await r.check('realtime.postgresChanges.insert', async () => {
        const hit = await waitFor(
          events,
          (e) => e.eventType === 'INSERT' && e.new?.user_id === users[0].id,
          RT_WAIT_MS,
        );
        assert(hit, `no INSERT for own row within ${RT_WAIT_MS}ms (events: ${events.length})`);
        return { received: events.length };
      });
      await r.check('realtime.postgresChanges.rlsFiltered', async () => {
        await sleep(1000);
        const foreign = events.filter((e) => e.new?.user_id && e.new.user_id !== users[0].id);
        assert(foreign.length === 0, `received ${foreign.length} events for another user's rows`);
      });
      await r.check('realtime.postgresChanges.update', async () => {
        await db.update(todos).set({ done: true }).where(eq(todos.id, ownRowId!));
        const hit = await waitFor(events, (e) => e.eventType === 'UPDATE' && e.new?.id === ownRowId, RT_WAIT_MS);
        assert(hit, 'no UPDATE event');
        return { oldHasFullRow: hit.old && 'title' in hit.old };
      });
      await r.check('realtime.postgresChanges.delete', async () => {
        await db.delete(todos).where(eq(todos.id, ownRowId!));
        const hit = await waitFor(events, (e) => e.eventType === 'DELETE' && e.old?.id === ownRowId, RT_WAIT_MS);
        assert(hit, 'no DELETE event');
      });
    } else {
      [
        'realtime.postgresChanges.insert',
        'realtime.postgresChanges.rlsFiltered',
        'realtime.postgresChanges.update',
        'realtime.postgresChanges.delete',
      ].forEach((n) => r.skip(n, 'subscribe failed'));
    }
  } else {
    dbCheckNames.slice(-8).forEach((n) => r.skip(n, 'needs migrated table and signed-in users'));
  }

  await runCleanup(cleanup);
  await close().catch(() => {});
  return r.results;
}

async function runCleanup(fns: Array<() => Promise<unknown>>) {
  for (const fn of fns.reverse()) await fn().catch((e) => console.log(`  (cleanup) ${errMsg(e)}`));
}

function short(v: unknown): string {
  if (v === undefined) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 140 ? `${s.slice(0, 137)}...` : s;
}

function report(all: Record<string, CheckResult[]>) {
  const names = [...new Set(Object.values(all).flatMap((rs) => rs.map((r) => r.name)))];
  const targets = Object.keys(all);
  const icon = { pass: '✅', fail: '❌', skip: '⏭️' } as const;
  const lines = [
    `# Supabase Multigres vs Postgres compatibility report`,
    ``,
    `Generated ${new Date().toISOString()} · driver: \`${DRIVER}\``,
    ``,
    `| check | ${targets.join(' | ')} |`,
    `| --- | ${targets.map(() => '---').join(' | ')} |`,
    ...names.map(
      (n) =>
        `| ${n} | ${targets
          .map((t) => {
            const r = all[t].find((x) => x.name === n);
            return r ? `${icon[r.status]} ${r.ms}ms` : '';
          })
          .join(' | ')} |`,
    ),
    ``,
    `## Differences`,
    ``,
  ];
  for (const n of names) {
    const rs = targets.map((t) => all[t].find((x) => x.name === n));
    const statuses = new Set(rs.map((r) => r?.status));
    const details = new Set(rs.map((r) => short(r?.detail ?? r?.error)));
    if (statuses.size > 1 || details.size > 1) {
      lines.push(`- **${n}**`);
      targets.forEach((t, i) => lines.push(`  - ${t}: ${rs[i]?.status} ${short(rs[i]?.error ?? rs[i]?.detail)}`));
    }
  }
  lines.push('', '## Failures', '');
  for (const t of targets)
    for (const r of all[t].filter((x) => x.status === 'fail')) lines.push(`- ${t} / ${r.name}: ${r.error}`);
  mkdirSync('reports', { recursive: true });
  writeFileSync('reports/report.md', lines.join('\n') + '\n');
  writeFileSync('reports/results.json', JSON.stringify(all, null, 2));
  console.log('\n' + lines.join('\n'));
}

async function main() {
  const all: Record<string, CheckResult[]> = {};
  const targets = loadTargets();
  console.log(`Targets: ${targets.map((t) => `${t.name} (${t.url})`).join(', ')}`);
  for (const t of targets) all[t.name] = await runTarget(t);
  report(all);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
