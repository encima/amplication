-- Realtime: postgres_changes on links/clicks and a private broadcast channel per user.

-- Add tables to the supabase_realtime publication (idempotent).
do $$
declare
  t text;
begin
  foreach t in array array['links', 'clicks'] loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;

-- Full old rows on UPDATE/DELETE so subscribers can diff click counts.
alter table public.links replica identity full;

-- Each user may join, listen on and send to their own private topic: user:<uid>.
create policy "realtime: read own user topic" on realtime.messages
  for select to authenticated
  using ((select realtime.topic()) = 'user:' || (select auth.uid())::text);

create policy "realtime: write own user topic" on realtime.messages
  for insert to authenticated
  with check ((select realtime.topic()) = 'user:' || (select auth.uid())::text);

-- Broadcast every click to the link owner's private topic.
create function public.broadcast_click()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_slug text;
begin
  select owner_id, slug into v_owner, v_slug from public.links where id = new.link_id;
  begin
    perform realtime.send(
      jsonb_build_object('link_id', new.link_id, 'slug', v_slug, 'clicked_at', new.clicked_at, 'referrer', new.referrer),
      'click',
      'user:' || v_owner::text,
      true
    );
  exception when others then
    -- Never fail a redirect because Realtime is unavailable.
    raise warning 'broadcast_click: %', sqlerrm;
  end;
  return new;
end;
$$;

revoke execute on function public.broadcast_click() from public, anon, authenticated;

create trigger clicks_broadcast
  after insert on public.clicks
  for each row execute procedure public.broadcast_click();
