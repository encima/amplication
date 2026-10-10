// End-to-end GoTo checks against one or more targets:
//   npm run test:target -- multigres
//   npm run test:compare            (multigres + normal)
import { mkdirSync, writeFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { availableTargets, loadTarget, type TargetEnv } from '../scripts/env';
import { authChecks } from './checks/auth';
import { cronChecks } from './checks/cron';
import { dataChecks } from './checks/data';
import { realtimeChecks } from './checks/realtime';
import { schemaChecks } from './checks/schema';
import { storageChecks } from './checks/storage';
import { errMsg, newClient, Runner, type CheckResult, type Ctx } from './lib';

async function runTarget(target: TargetEnv): Promise<CheckResult[]> {
  console.log(`\n=== ${target.name} (${target.url})`);
  const r = new Runner();
  const ctx: Ctx = {
    target,
    stamp: Date.now().toString(36),
    admin: newClient(target, target.secretKey),
    anon: newClient(target, target.publishableKey),
    users: {},
    links: {},
    cleanup: [],
  };

  if (target.databaseUrl) {
    const sql = postgres(target.databaseUrl, { max: 3, connect_timeout: 15, onnotice: () => {} });
    try {
      await sql`select 1`;
      ctx.sql = sql;
      ctx.db = drizzle(sql);
    } catch (e) {
      console.log(`  ! direct DB connection failed, DB checks will be skipped: ${errMsg(e)}`);
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  } else {
    console.log('  ! DATABASE_URL not set, DB checks will be skipped');
  }

  try {
    await authChecks(r, ctx);
    await schemaChecks(r, ctx);
    await dataChecks(r, ctx);
    await realtimeChecks(r, ctx);
    await storageChecks(r, ctx);
    await cronChecks(r, ctx);
  } finally {
    for (const fn of ctx.cleanup.reverse()) await fn().catch((e) => console.log(`  (cleanup) ${errMsg(e)}`));
    for (const c of [ctx.admin, ctx.anon, ...Object.values(ctx.users).map((u) => u!.client)]) c.removeAllChannels();
    await ctx.sql?.end({ timeout: 5 });
  }
  return r.results;
}

function short(v: unknown): string {
  if (v === undefined) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return (s.length > 160 ? `${s.slice(0, 157)}...` : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function report(all: Record<string, CheckResult[]>) {
  const targets = Object.keys(all);
  const names = [...new Set(Object.values(all).flatMap((rs) => rs.map((x) => x.name)))];
  const icon = { pass: '✅', fail: '❌', skip: '⏭️' } as const;
  const cell = (t: string, n: string) => {
    const x = all[t].find((y) => y.name === n);
    return x ? `${icon[x.status]} ${x.status === 'pass' ? `${x.ms}ms` : short(x.error)}` : '';
  };
  const totals = targets.map((t) => {
    const c = (s: string) => all[t].filter((x) => x.status === s).length;
    return `**${t}**: ${c('pass')} passed, ${c('fail')} failed, ${c('skip')} skipped`;
  });
  const lines = [
    '# GoTo test report',
    '',
    `Generated ${new Date().toISOString()}`,
    '',
    totals.join(' · '),
    '',
    `| check | ${targets.join(' | ')} |`,
    `| --- | ${targets.map(() => '---').join(' | ')} |`,
    ...names.map((n) => `| ${n} | ${targets.map((t) => cell(t, n)).join(' | ')} |`),
  ];
  if (targets.length > 1) {
    lines.push('', '## Differences', '');
    for (const n of names) {
      const rs = targets.map((t) => all[t].find((x) => x.name === n));
      if (new Set(rs.map((x) => x?.status)).size > 1)
        lines.push(`- **${n}**: ${targets.map((t, i) => `${t} ${rs[i]?.status} ${short(rs[i]?.error ?? rs[i]?.detail)}`).join(' · ')}`);
    }
  }
  mkdirSync('reports', { recursive: true });
  const file = `reports/${targets.join('-vs-')}.md`;
  writeFileSync(file, lines.join('\n') + '\n');
  writeFileSync(file.replace(/\.md$/, '.json'), JSON.stringify(all, null, 2));
  console.log(`\n${lines.join('\n')}\n\nWrote ${file}`);
}

const names = process.argv.slice(2);
if (!names.length) {
  console.error(`Usage: npm run test:target -- <target...>. Available: ${availableTargets().join(', ') || 'none'}`);
  process.exit(1);
}
const targets = names.map(loadTarget);
const all: Record<string, CheckResult[]> = {};
for (const t of targets) all[t.name] = await runTarget(t);
report(all);
process.exit(Object.values(all).some((rs) => rs.some((x) => x.status === 'fail')) ? 1 : 0);
