// Apply supabase/migrations to a target over a direct connection, recording them in
// supabase_migrations.schema_migrations exactly like `supabase db push` does, so the two
// can be mixed. Useful when the CLI can't reach the target's Management API.
import { readdirSync, readFileSync } from 'node:fs';
import postgres from 'postgres';
import { targetFromArgs } from './env';

const target = targetFromArgs();
if (!target.databaseUrl) throw new Error(`DATABASE_URL is not set for ${target.name}`);

const dir = 'supabase/migrations';
const files = readdirSync(dir)
  .filter((f) => /^\d+_.+\.sql$/.test(f))
  .sort();

const sql = postgres(target.databaseUrl, { max: 1, onnotice: () => {} });
try {
  await sql`create schema if not exists supabase_migrations`;
  await sql`create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text)`;
  const applied = new Set((await sql`select version from supabase_migrations.schema_migrations`).map((r) => r.version));

  let count = 0;
  for (const file of files) {
    const [, version, name] = file.match(/^(\d+)_(.+)\.sql$/)!;
    if (applied.has(version)) continue;
    const body = readFileSync(`${dir}/${file}`, 'utf8');
    process.stdout.write(`applying ${file} … `);
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into supabase_migrations.schema_migrations (version, statements, name) values (${version}, ${[body]}, ${name})`;
    });
    console.log('ok');
    count++;
  }
  console.log(count ? `${target.name}: applied ${count} migration(s)` : `${target.name}: up to date`);
} finally {
  await sql.end({ timeout: 5 });
}
