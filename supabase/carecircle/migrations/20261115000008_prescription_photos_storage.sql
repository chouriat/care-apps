-- CC-4a [safety 2/2]: Prescription photos private Storage bucket, RLS policies,
-- expired photo listing RPC, and daily pg_cron + pg_net cleanup schedule.
--
-- Checked 2026-11-15:
-- - Supabase Storage Delete Objects:
--   https://supabase.com/docs/guides/storage/management/delete-objects
-- - Supabase Scheduling Edge Functions (pg_cron + pg_net + Supabase Vault):
--   https://supabase.com/docs/guides/functions/schedule-functions
-- - Supabase pg_net extension (`net.http_post`):
--   https://supabase.com/docs/guides/database/extensions/pg_net

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

-- 1. Private `prescription-photos` bucket: image/jpeg only, 2 MB (2,097,152 bytes) limit.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'prescription-photos',
  'prescription-photos',
  false,
  2097152,
  array['image/jpeg']
)
on conflict (id) do update
set
  name = excluded.name,
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- 2. Extract `<circle_id>` from `<circle_id>/<uuid>.jpg` only when the entire object name
--    matches two lowercase UUIDs and `.jpg`. Returns NULL (never throws 22P02) for any other path.
create or replace function public.prescription_photo_circle_id(p_name text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_name is null
     or p_name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$'
  then
    return null;
  end if;

  return pg_catalog.substr(p_name, 1, 36)::uuid;
end;
$$;

revoke all on function public.prescription_photo_circle_id(text) from public, anon;
grant execute on function public.prescription_photo_circle_id(text) to authenticated, service_role;

-- 3. RLS policies on `storage.objects` for `prescription-photos`.
--    Only `owner` and `helper` of `<circle_id>` in the path may INSERT, SELECT, or DELETE.
--    No UPDATE policy exists (a retake is a new upload), and `owner` / `owner_id` on
--    `storage.objects` are never trusted so former helpers lose access immediately.
drop policy if exists prescription_photos_insert_owner_helper on storage.objects;
create policy prescription_photos_insert_owner_helper
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'prescription-photos'
    and public.has_circle_role(
      public.prescription_photo_circle_id(name),
      array['owner'::public.member_role, 'helper'::public.member_role]
    )
  );

drop policy if exists prescription_photos_select_owner_helper on storage.objects;
create policy prescription_photos_select_owner_helper
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'prescription-photos'
    and public.has_circle_role(
      public.prescription_photo_circle_id(name),
      array['owner'::public.member_role, 'helper'::public.member_role]
    )
  );

drop policy if exists prescription_photos_delete_owner_helper on storage.objects;
create policy prescription_photos_delete_owner_helper
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'prescription-photos'
    and public.has_circle_role(
      public.prescription_photo_circle_id(name),
      array['owner'::public.member_role, 'helper'::public.member_role]
    )
  );

-- 4. Server-only listing of expired prescription photos (older than 24 hours, oldest first).
--    Actual deletion must go through the Storage API via `cleanup-prescription-photos` so both
--    the bucket object and metadata row are removed.
create or replace function public.list_expired_prescription_photos(p_limit integer default 1000)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select o.name
    from storage.objects o
   where o.bucket_id = 'prescription-photos'
     and o.created_at < pg_catalog.now() - interval '24 hours'
   order by o.created_at asc, o.name asc
   limit greatest(1, least(coalesce(p_limit, 1000), 1000));
$$;

revoke all on function public.list_expired_prescription_photos(integer) from public, anon, authenticated;
grant execute on function public.list_expired_prescription_photos(integer) to service_role;

-- 5. Daily pg_cron + pg_net schedule (`15 3 * * *` UTC) invoking `cleanup-prescription-photos`
--    with `project_url` and `service_role_key` from `vault.decrypted_secrets`.
do $cron$
begin
  if exists (select 1 from pg_catalog.pg_namespace where nspname = 'cron') then
    if exists (
      select 1
        from cron.job
       where jobname = 'carecircle-cleanup-prescription-photos-daily'
    ) then
      perform cron.unschedule('carecircle-cleanup-prescription-photos-daily');
    end if;

    perform cron.schedule(
      'carecircle-cleanup-prescription-photos-daily',
      '15 3 * * *',
      $job$
      select net.http_post(
        url := rtrim((select decrypted_secret from vault.decrypted_secrets where name = 'project_url' order by created_at desc limit 1), '/')
               || '/functions/v1/cleanup-prescription-photos',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' order by created_at desc limit 1)
        ),
        body := '{}'::jsonb
      ) as request_id;
      $job$
    );
  end if;
end;
$cron$;
