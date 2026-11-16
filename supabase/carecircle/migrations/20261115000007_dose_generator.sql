-- CC-2a [safety 2/2]: Dose generator schedule-edit reconciliation trigger and hourly pg_cron job.
-- Spec: docs/spec/carecircle.md > Part 2 > Dose engine rules 1, 2, 4, 5.
-- Supabase docs checked 2026-11-15:
-- - Scheduling Edge Functions (`pg_cron` + `pg_net` + `vault.decrypted_secrets`):
--   https://supabase.com/docs/guides/functions/schedule-functions
-- - `pg_net` extension (`net.http_post` and `net.http_request_queue`):
--   https://supabase.com/docs/guides/database/extensions/pg_net

create extension if not exists pg_net;
create extension if not exists pg_cron;

create or replace function public.reconcile_medication_schedule_edit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_should_enqueue boolean := false;
  v_project_url text;
  v_cron_secret text;
begin
  if tg_op = 'INSERT' then
    v_should_enqueue := true;
  elsif tg_op = 'UPDATE' then
    if (new.schedule is distinct from old.schedule)
       or (new.active is distinct from old.active)
       or (new.start_date is distinct from old.start_date)
       or (new.end_date is distinct from old.end_date)
    then
      delete from public.dose_events
       where medication_id = new.id
         and status = 'pending'::public.dose_status
         and due_at > pg_catalog.now();
      v_should_enqueue := true;
    end if;
  end if;

  if v_should_enqueue then
    select ds.decrypted_secret
      into v_project_url
      from vault.decrypted_secrets ds
     where ds.name = 'project_url'
     order by ds.created_at desc
     limit 1;

    select ds.decrypted_secret
      into v_cron_secret
      from vault.decrypted_secrets ds
     where ds.name = 'cron_secret'
     order by ds.created_at desc
     limit 1;

    if v_project_url is null or pg_catalog.btrim(v_project_url) = ''
       or v_cron_secret is null or pg_catalog.btrim(v_cron_secret) = '' then
      raise warning 'materialize-doses not queued for medication %: Vault secret project_url or cron_secret is missing', new.id;
    else
      perform net.http_post(
        url := pg_catalog.rtrim(pg_catalog.btrim(v_project_url), '/') || '/functions/v1/materialize-doses',
        headers := pg_catalog.jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || pg_catalog.btrim(v_cron_secret)
        ),
        body := pg_catalog.jsonb_build_object(
          'medication_id', new.id::text
        )
      );
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.reconcile_medication_schedule_edit() from public, anon, authenticated;

drop trigger if exists medications_reconcile_schedule_edit on public.medications;

create trigger medications_reconcile_schedule_edit
  after insert or update on public.medications
  for each row
  execute function public.reconcile_medication_schedule_edit();

do $$
begin
  if exists (select 1 from cron.job where jobname = 'carecircle-materialize-doses-hourly') then
    perform cron.unschedule('carecircle-materialize-doses-hourly');
  end if;
end;
$$;

select cron.schedule(
  'carecircle-materialize-doses-hourly',
  '0 * * * *',
  $cron$
  select
    case
      when (select decrypted_secret from vault.decrypted_secrets where name = 'project_url' order by created_at desc limit 1) is not null
       and (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret' order by created_at desc limit 1) is not null
      then net.http_post(
        url := rtrim((select decrypted_secret from vault.decrypted_secrets where name = 'project_url' order by created_at desc limit 1), '/') || '/functions/v1/materialize-doses',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret' order by created_at desc limit 1)
        ),
        body := '{}'::jsonb
      )
      else null
    end;
  $cron$
);
