-- One profile per auth user, created and kept in sync by triggers on auth.users.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username extensions.citext unique check (username ~ '^[a-zA-Z0-9_-]{3,32}$'),
  display_name text,
  avatar_path text,
  is_anonymous boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create trigger profiles_updated_at
  before update on public.profiles
  for each row execute procedure extensions.moddatetime (updated_at);

create policy "profiles: read own" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

create policy "profiles: update own" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- Only these columns are user-editable; is_anonymous is maintained by the triggers below.
revoke insert, update on public.profiles from anon, authenticated;
grant update (username, display_name, avatar_path) on public.profiles to authenticated;

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, is_anonymous)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'user_name', split_part(new.email, '@', 1)),
    coalesce(new.is_anonymous, false)
  );
  return new;
end;
$$;

-- Anonymous users who add an email or link an OAuth identity become permanent.
create function public.handle_user_updated()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles
     set is_anonymous = coalesce(new.is_anonymous, false),
         display_name = coalesce(display_name, new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1))
   where id = new.id;
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.handle_user_updated() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create trigger on_auth_user_updated
  after update of is_anonymous, email on auth.users
  for each row execute procedure public.handle_user_updated();
