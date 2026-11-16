-- CC-2b [safety 2/2]: Missed-dose 5-minute pg_cron job (`carecircle-mark-missed`),
-- `public.set_dose_status("doseEventId", status)` RPC, direct `UPDATE` revocation on
-- `public.dose_events` for `authenticated`, and `public.dose_events` in `supabase_realtime`.
-- Spec: docs/spec/carecircle.md > Part 2 > Dose engine rules 3 & 6, Part 5 > RPC functions.

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- 1. Revoke direct UPDATE on public.dose_events from authenticated (doses are recorded only
-- through public.set_dose_status; service_role keeps full access for mark-missed).
revoke update on table public.dose_events from authenticated;
revoke update (id, medication_id, circle_id, due_at, status, acted_by, acted_at)
  on public.dose_events
  from authenticated;

drop policy if exists dose_events_update_caregiver on public.dose_events;

-- 2. RPC: public.set_dose_status("doseEventId" uuid, status public.dose_status)
create or replace function public.set_dose_status(
  "doseEventId" uuid,
  status public.dose_status
)
returns public.dose_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_dose public.dose_events;
begin
  v_user_id := (select auth.uid());
  if v_user_id is null then
    raise exception 'Authentication required'
      using errcode = '42501';
  end if;

  if status is null
     or status not in ('given'::public.dose_status, 'skipped'::public.dose_status)
  then
    raise exception 'Invalid dose status: must be given or skipped'
      using errcode = '22023';
  end if;

  if "doseEventId" is null then
    raise exception 'Dose not found or access denied'
      using errcode = '42501';
  end if;

  select d.*
    into v_dose
    from public.dose_events d
   where d.id = "doseEventId"
     for update;

  if not found then
    raise exception 'Dose not found or access denied'
      using errcode = '42501';
  end if;

  -- Check membership & role before checking whether the dose was already recorded so
  -- viewers and outsiders never learn anything about another circle's dose status.
  if not public.has_circle_role(
    v_dose.circle_id,
    array['owner'::public.member_role, 'helper'::public.member_role]
  ) then
    raise exception 'Only circle owners and helpers can record doses'
      using errcode = '42501';
  end if;

  if v_dose.status in ('given'::public.dose_status, 'skipped'::public.dose_status) then
    raise exception 'DOSE_ALREADY_RECORDED'
      using errcode = 'P0001';
  end if;

  update public.dose_events
     set status = set_dose_status.status,
         acted_by = v_user_id,
         acted_at = pg_catalog.now()
   where id = v_dose.id
  returning * into v_dose;

  return v_dose;
end;
$$;

revoke all on function public.set_dose_status(uuid, public.dose_status) from public, anon;
grant execute on function public.set_dose_status(uuid, public.dose_status) to authenticated, service_role;

-- 3. Schedule carecircle-mark-missed every 5 minutes (*/5 * * * *) via pg_cron + pg_net + Vault
do $$
begin
  if exists (select 1 from cron.job where jobname = 'carecircle-mark-missed') then
    perform cron.unschedule('carecircle-mark-missed');
  end if;
end;
$$;

select cron.schedule(
  'carecircle-mark-missed',
  '*/5 * * * *',
  $cron$
  select
    case
      when (select decrypted_secret from vault.decrypted_secrets where name = 'project_url' order by created_at desc limit 1) is not null
       and (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret' order by created_at desc limit 1) is not null
      then net.http_post(
        url := rtrim((select decrypted_secret from vault.decrypted_secrets where name = 'project_url' order by created_at desc limit 1), '/') || '/functions/v1/mark-missed',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret' order by created_at desc limit 1)
        ),
        body := '{}'::jsonb
      )
    end;
  $cron$
);

-- 4. Add public.dose_events to the supabase_realtime publication
do $$
begin
  if not exists (
    select 1
      from pg_catalog.pg_publication
     where pubname = 'supabase_realtime'
  ) then
    create publication supabase_realtime;
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'dose_events'
  ) then
    alter publication supabase_realtime add table public.dose_events;
  end if;
end;
$$;
