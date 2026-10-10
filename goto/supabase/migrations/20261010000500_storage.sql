-- Storage: public link icons and private avatars, each user writing under <uid>/.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('link-icons', 'link-icons', true, 1048576, array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']),
  ('avatars', 'avatars', false, 2097152, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "link-icons: anyone can read" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'link-icons');

create policy "link-icons: owners write own folder" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'link-icons' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "link-icons: owners update own folder" on storage.objects
  for update to authenticated
  using (bucket_id = 'link-icons' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'link-icons' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "link-icons: owners delete own folder" on storage.objects
  for delete to authenticated
  using (bucket_id = 'link-icons' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "avatars: owners read own folder" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "avatars: owners write own folder" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "avatars: owners update own folder" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "avatars: owners delete own folder" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
