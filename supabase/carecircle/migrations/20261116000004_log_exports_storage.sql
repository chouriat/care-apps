-- CC-7: Private `log-exports` Storage bucket (service_role only; no client role may read or write),
-- server-only expired exports listing RPC, and daily pg_cron + pg_net cleanup schedule.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

-- 1. Private `log-exports` bucket: application/pdf only, 10 MB (10,485,760 bytes) limit.
--    No RLS policies are created on `storage.objects` for `bucket_id = 'log-exports'`, so neither
--    `authenticated` nor `anon` can SELECT, INSERT, UPDATE, or DELETE any object in `log-exports`.
--    Only `service_role` (which bypasses RLS) can write PDFs and mint signed URLs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'log-exports',
  'log-exports',
  false,
  10485760,
  array['application/pdf']
)
on conflict (id) do update
set
  name = excluded.name,
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- 2. Server-only listing of expired log export PDFs (older than 24 hours, oldest first).
create or replace function public.list_expired_log_exports(p_limit integer default 1000)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select o.name
    from storage.objects o
   where o.bucket_id = 'log-exports'
     and o.created_at < pg_catalog.now() - interval '24 hours'
   order by o.created_at asc, o.name asc
   limit greatest(1, least(coalesce(p_limit, 1000), 1000));
$$;

revoke all on function public.list_expired_log_exports(integer) from public, anon, authenticated;
grant execute on function public.list_expired_log_exports(integer) to service_role;

-- 3. Daily pg_cron + pg_net schedule (`25 3 * * *` UTC) invoking `cleanup-prescription-photos`
--    with `{"bucket": "log-exports"}` to delete expired `log-exports` PDFs older than 24 hours.
do $cron$
begin
  if exists (select 1 from pg_catalog.pg_namespace where nspname = 'cron') then
    if exists (
      select 1
        from cron.job
       where jobname = 'carecircle-cleanup-log-exports-daily'
    ) then
      perform cron.unschedule('carecircle-cleanup-log-exports-daily');
    end if;

    perform cron.schedule(
      'carecircle-cleanup-log-exports-daily',
      '25 3 * * *',
      $job$
      select net.http_post(
        url := rtrim((select decrypted_secret from vault.decrypted_secrets where name = 'project_url' order by created_at desc limit 1), '/')
               || '/functions/v1/cleanup-prescription-photos',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' order by created_at desc limit 1)
        ),
        body := '{"bucket":"log-exports"}'::jsonb
      ) as request_id;
      $job$
    );
  end if;
end;
$cron$;
