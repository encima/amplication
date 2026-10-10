import { readdirSync } from 'node:fs';
import { assert, ok, type Ctx, type Runner } from '../lib';

const EXTENSIONS = ['citext', 'pg_trgm', 'moddatetime', 'pg_cron', 'pg_net'];
const CRON_JOBS = ['goto-purge-expired-links', 'goto-rollup-link-stats', 'goto-prune-clicks', 'goto-check-links'];
const TABLES = ['profiles', 'links', 'clicks', 'link_stats_daily'];

export async function schemaChecks(r: Runner, ctx: Ctx) {
  const sql = ctx.sql;
  const db = { needs: [sql] };

  await r.check(
    'db.connect',
    async () => {
      const [row] = await sql!`select current_setting('server_version') as version, current_user as user`;
      return row;
    },
    db,
  );

  await r.check(
    'db.migrationsApplied',
    async () => {
      const local = readdirSync('supabase/migrations')
        .map((f) => f.match(/^(\d+)_/)?.[1])
        .filter(Boolean) as string[];
      const rows = await sql!`select version from supabase_migrations.schema_migrations`;
      const applied = new Set(rows.map((x) => x.version));
      const missing = local.filter((v) => !applied.has(v));
      assert(!missing.length, `not applied: ${missing.join(', ')} (run npm run db:push -- ${ctx.target.name})`);
      return { applied: local.length };
    },
    db,
  );

  await r.check(
    'db.extensions',
    async () => {
      const rows = await sql!`select e.extname, e.extversion, n.nspname as schema
        from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = any(${EXTENSIONS})`;
      const missing = EXTENSIONS.filter((x) => !rows.some((r) => r.extname === x));
      assert(!missing.length, `missing extensions: ${missing.join(', ')}`);
      return Object.fromEntries(rows.map((x) => [x.extname, `${x.extversion}@${x.schema}`]));
    },
    db,
  );

  await r.check(
    'db.rlsEnabled',
    async () => {
      const rows = await sql!`select relname, relrowsecurity from pg_class
        where relnamespace = 'public'::regnamespace and relname = any(${TABLES})`;
      const off = TABLES.filter((x) => !rows.find((r) => r.relname === x)?.relrowsecurity);
      assert(!off.length, `RLS off or table missing: ${off.join(', ')}`);
    },
    db,
  );

  await r.check(
    'db.cronJobs',
    async () => {
      const rows = await sql!`select jobname, schedule, active from cron.job where jobname like 'goto-%'`;
      const missing = CRON_JOBS.filter((j) => !rows.some((r) => r.jobname === j && r.active));
      assert(!missing.length, `missing/inactive cron jobs: ${missing.join(', ')}`);
      return Object.fromEntries(rows.map((x) => [x.jobname, x.schedule]));
    },
    db,
  );

  await r.check(
    'db.realtimePublication',
    async () => {
      const rows = await sql!`select tablename from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public'`;
      const missing = ['links', 'clicks'].filter((x) => !rows.some((r) => r.tablename === x));
      assert(!missing.length, `not in supabase_realtime: ${missing.join(', ')}`);
    },
    db,
  );

  await r.check('storage.buckets', async () => {
    const buckets = ok(await ctx.admin.storage.listBuckets());
    const icons = buckets.find((b) => b.id === 'link-icons');
    const avatars = buckets.find((b) => b.id === 'avatars');
    assert(icons?.public === true, 'link-icons bucket missing or not public');
    assert(avatars && !avatars.public, 'avatars bucket missing or public');
  });
}
