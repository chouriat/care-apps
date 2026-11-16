-- CC-5a: Visit audio private Storage bucket, RLS policies, expired audio listing RPC,
-- and daily pg_cron + pg_net cleanup schedule.
--
-- Checked 2026-11-16:
-- - Supabase Storage Delete Objects:
--   https://supabase.com/docs/guides/storage/management/delete-objects
-- - Supabase Scheduling Edge Functions (pg_cron + pg_net + Supabase Vault):
--   https://supabase.com/docs/guides/functions/schedule-functions

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

-- 1. Private `visit-audio` bucket: audio/mp4 and audio/m4a only, 10 MB (10,485,760 bytes) limit.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'visit-audio',
  'visit-audio',
  false,
  10485760,
  array['audio/mp4', 'audio/m4a']
)
on conflict (id) do update
set
  name = excluded.name,
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- 2. Extract `<circle_id>` from `<circle_id>/<uuid>.m4a` only when the entire object name
--    matches two lowercase UUIDs and `.m4a`. Returns NULL (never throws 22P02) for any other path.
create or replace function public.visit_audio_circle_id(p_name text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_name is null
     or p_name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.m4a$'
  then
    return null;
  end if;

  return pg_catalog.substr(p_name, 1, 36)::uuid;
end;
$$;

revoke all on function public.visit_audio_circle_id(text) from public, anon;
grant execute on function public.visit_audio_circle_id(text) to authenticated, service_role;

-- 3. RLS policies on `storage.objects` for `visit-audio`.
--    Only `owner` and `helper` of `<circle_id>` in the path may INSERT and DELETE.
--    Nobody may read (`SELECT`) through the client API (the AI gateway reads with `service_role`
--    after its own checks); `SELECT` is enabled only inside a Storage API delete transaction
--    (`storage.allow_delete_query = 'true'`) so PostgreSQL can locate the row for `DELETE ... WHERE`.
--    No `UPDATE` policy exists, and `owner` / `owner_id` on `storage.objects` are never trusted.
drop policy if exists visit_audio_insert_owner_helper on storage.objects;
create policy visit_audio_insert_owner_helper
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'visit-audio'
    and public.has_circle_role(
      public.visit_audio_circle_id(name),
      array['owner'::public.member_role, 'helper'::public.member_role]
    )
  );

drop policy if exists visit_audio_select_for_delete_owner_helper on storage.objects;
create policy visit_audio_select_for_delete_owner_helper
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'visit-audio'
    and coalesce(pg_catalog.current_setting('storage.allow_delete_query', true), 'false') = 'true'
    and public.has_circle_role(
      public.visit_audio_circle_id(name),
      array['owner'::public.member_role, 'helper'::public.member_role]
    )
  );

drop policy if exists visit_audio_delete_owner_helper on storage.objects;
create policy visit_audio_delete_owner_helper
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'visit-audio'
    and public.has_circle_role(
      public.visit_audio_circle_id(name),
      array['owner'::public.member_role, 'helper'::public.member_role]
    )
  );

-- 4. Server-only listing of expired visit audio objects (older than 24 hours, oldest first).
create or replace function public.list_expired_visit_audio(p_limit integer default 1000)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select o.name
    from storage.objects o
   where o.bucket_id = 'visit-audio'
     and o.created_at < pg_catalog.now() - interval '24 hours'
   order by o.created_at asc, o.name asc
   limit greatest(1, least(coalesce(p_limit, 1000), 1000));
$$;

revoke all on function public.list_expired_visit_audio(integer) from public, anon, authenticated;
grant execute on function public.list_expired_visit_audio(integer) to service_role;

-- 5. Daily pg_cron + pg_net schedule (`20 3 * * *` UTC) invoking `cleanup-prescription-photos`
--    with `{"includeVisitAudio": true}` to delete expired `visit-audio` objects as well.
do $cron$
begin
  if exists (select 1 from pg_catalog.pg_namespace where nspname = 'cron') then
    if exists (
      select 1
        from cron.job
       where jobname = 'carecircle-cleanup-visit-audio-daily'
    ) then
      perform cron.unschedule('carecircle-cleanup-visit-audio-daily');
    end if;

    perform cron.schedule(
      'carecircle-cleanup-visit-audio-daily',
      '20 3 * * *',
      $job$
      select net.http_post(
        url := rtrim((select decrypted_secret from vault.decrypted_secrets where name = 'project_url' order by created_at desc limit 1), '/')
               || '/functions/v1/cleanup-prescription-photos',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' order by created_at desc limit 1)
        ),
        body := '{"includeVisitAudio":true}'::jsonb
      ) as request_id;
      $job$
    );
  end if;
end;
$cron$;
