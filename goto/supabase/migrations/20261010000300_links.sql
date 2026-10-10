-- Go links: a slug that redirects to a URL, with click tracking.
create table public.links (
  id bigint generated always as identity primary key,
  owner_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  slug extensions.citext not null unique check (slug ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$'),
  url text not null check (url ~ '^https?://'),
  title text,
  is_public boolean not null default false,
  expires_at timestamptz,
  icon_path text,
  click_count bigint not null default 0,
  last_checked_at timestamptz,
  last_status integer,
  last_check_request_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index links_owner_id_idx on public.links (owner_id);
create index links_slug_trgm_idx on public.links using gin (slug extensions.gin_trgm_ops);
create index links_title_trgm_idx on public.links using gin (title extensions.gin_trgm_ops);

create trigger links_updated_at
  before update on public.links
  for each row execute procedure extensions.moddatetime (updated_at);

create table public.clicks (
  id bigint generated always as identity primary key,
  link_id bigint not null references public.links (id) on delete cascade,
  clicked_at timestamptz not null default now(),
  referrer text,
  user_agent text
);

create index clicks_link_id_clicked_at_idx on public.clicks (link_id, clicked_at);

create table public.link_stats_daily (
  link_id bigint not null references public.links (id) on delete cascade,
  day date not null,
  clicks bigint not null,
  primary key (link_id, day)
);

alter table public.links enable row level security;
alter table public.clicks enable row level security;
alter table public.link_stats_daily enable row level security;

-- links: owners manage their own links; anyone can see public ones.
create policy "links: read own or public" on public.links
  for select to anon, authenticated
  using (is_public or owner_id = (select auth.uid()));

create policy "links: insert own" on public.links
  for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy "links: update own" on public.links
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy "links: delete own" on public.links
  for delete to authenticated
  using (owner_id = (select auth.uid()));

-- Anonymous users may only create private links.
create policy "links: anonymous users keep links private" on public.links
  as restrictive
  for insert to authenticated
  with check (not coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) or not is_public);

create policy "links: anonymous users cannot publish" on public.links
  as restrictive
  for update to authenticated
  with check (not coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) or not is_public);

-- Counters and health-check columns are written by the database, not by clients.
revoke insert, update on public.links from anon, authenticated;
grant insert (slug, url, title, is_public, expires_at, icon_path) on public.links to authenticated;
grant update (slug, url, title, is_public, expires_at, icon_path) on public.links to authenticated;

-- clicks and stats: readable by the link owner; written only by resolve_link() and cron.
create policy "clicks: owner reads" on public.clicks
  for select to authenticated
  using (exists (select 1 from public.links l where l.id = link_id and l.owner_id = (select auth.uid())));

create policy "link_stats_daily: owner reads" on public.link_stats_daily
  for select to authenticated
  using (exists (select 1 from public.links l where l.id = link_id and l.owner_id = (select auth.uid())));

revoke insert, update, delete on public.clicks, public.link_stats_daily from anon, authenticated;

-- Resolve a slug to its URL and record the click. Public links work for everyone,
-- private links only for their owner. Returns null when the link is missing or expired.
create function public.resolve_link(p_slug text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link public.links%rowtype;
  v_headers json := nullif(current_setting('request.headers', true), '')::json;
begin
  -- citext's case-insensitive = lives in the extensions schema; with an empty search_path a bare
  -- = would fall back to case-sensitive text equality.
  select * into v_link from public.links where slug operator(extensions.=) p_slug::extensions.citext;

  if not found
     or (v_link.expires_at is not null and v_link.expires_at <= now())
     or (not v_link.is_public and v_link.owner_id is distinct from auth.uid()) then
    return null;
  end if;

  insert into public.clicks (link_id, referrer, user_agent)
  values (v_link.id, v_headers ->> 'referer', v_headers ->> 'user-agent');

  update public.links set click_count = click_count + 1 where id = v_link.id;

  return v_link.url;
end;
$$;

revoke execute on function public.resolve_link(text) from public;
grant execute on function public.resolve_link(text) to anon, authenticated;

-- Fuzzy search over links visible to the caller (RLS applies: security invoker).
create function public.search_links(p_query text, p_limit integer default 20)
returns setof public.links
language sql
stable
security invoker
set search_path = ''
as $$
  select l.*
    from public.links l
   where l.slug operator(pg_catalog.~~*) ('%' || p_query || '%')
      or l.title operator(pg_catalog.~~*) ('%' || p_query || '%')
      or extensions.similarity(l.slug::text, p_query) > 0.3
   order by greatest(extensions.similarity(l.slug::text, p_query), extensions.similarity(coalesce(l.title, ''), p_query)) desc,
            l.created_at desc
   limit least(p_limit, 100);
$$;

revoke execute on function public.search_links(text, integer) from public;
grant execute on function public.search_links(text, integer) to anon, authenticated;
