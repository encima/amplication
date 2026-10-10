// Remove everything GoTo created on a target so migrations can be re-applied from scratch.
// Extensions are left installed.
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import { targetFromArgs } from './env';

const target = targetFromArgs();
if (!target.databaseUrl) throw new Error(`DATABASE_URL is not set for ${target.name}`);

const admin = createClient(target.url, target.secretKey, { auth: { persistSession: false } });
for (const bucket of ['link-icons', 'avatars']) {
  const { error } = await admin.storage.emptyBucket(bucket);
  if (!error) await admin.storage.deleteBucket(bucket);
  console.log(`bucket ${bucket}: ${error ? error.message : 'removed'}`);
}

const sql = postgres(target.databaseUrl, { max: 1, onnotice: () => {} });
try {
  await sql.unsafe(`
    do $$
    declare j record;
    begin
      if to_regnamespace('cron') is not null then
        for j in select jobname from cron.job where jobname like 'goto-%' loop
          perform cron.unschedule(j.jobname);
        end loop;
      end if;
    end $$;

    drop trigger if exists on_auth_user_created on auth.users;
    drop trigger if exists on_auth_user_updated on auth.users;

    drop policy if exists "realtime: read own user topic" on realtime.messages;
    drop policy if exists "realtime: write own user topic" on realtime.messages;

    drop policy if exists "link-icons: anyone can read" on storage.objects;
    drop policy if exists "link-icons: owners write own folder" on storage.objects;
    drop policy if exists "link-icons: owners update own folder" on storage.objects;
    drop policy if exists "link-icons: owners delete own folder" on storage.objects;
    drop policy if exists "avatars: owners read own folder" on storage.objects;
    drop policy if exists "avatars: owners write own folder" on storage.objects;
    drop policy if exists "avatars: owners update own folder" on storage.objects;
    drop policy if exists "avatars: owners delete own folder" on storage.objects;

    drop table if exists public.link_stats_daily, public.clicks, public.links, public.profiles cascade;

    drop function if exists public.handle_new_user(), public.handle_user_updated(), public.resolve_link(text),
      public.search_links(text, integer), public.broadcast_click(), public.purge_expired_links(),
      public.rollup_link_stats(), public.prune_clicks(), public.check_links(integer);

    delete from supabase_migrations.schema_migrations where version like '20261010%';
  `);
  console.log(`${target.name}: GoTo schema removed`);
} finally {
  await sql.end({ timeout: 5 });
}
