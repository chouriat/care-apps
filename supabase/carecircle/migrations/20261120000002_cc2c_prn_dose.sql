-- CC-2c [safety 2/2]: `public.log_prn_dose("medicationId" uuid) returns public.dose_events`
-- Spec: `docs/spec/carecircle.md` > Part 2 > Dose engine rule 2 ("an `as_needed` medicine has no
-- scheduled doses; the person taps 'Gave a dose now', which records a given dose at the current time").

create or replace function public.log_prn_dose(
  "medicationId" uuid
)
returns public.dose_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_med public.medications;
  v_now timestamptz;
  v_dose public.dose_events;
begin
  v_user_id := (select auth.uid());
  if v_user_id is null then
    raise exception 'Authentication required'
      using errcode = '42501';
  end if;

  if "medicationId" is null then
    raise exception 'Medication not found or access denied'
      using errcode = '42501';
  end if;

  -- Lock the medication row before checking membership/role and the 1-second duplicate window so
  -- two concurrent transactions from two phones cannot both pass the 1-second check.
  select m.*
    into v_med
    from public.medications m
   where m.id = "medicationId"
     for update;

  if not found then
    raise exception 'Medication not found or access denied'
      using errcode = '42501';
  end if;

  -- Check circle membership and role (owner or helper) BEFORE schedule kind or active state so
  -- viewers and non-members never learn anything about a medication from error codes.
  if not public.has_circle_role(
    v_med.circle_id,
    array['owner'::public.member_role, 'helper'::public.member_role]
  ) then
    raise exception 'Only circle owners and helpers can record doses'
      using errcode = '42501';
  end if;

  if not v_med.active then
    raise exception 'MEDICATION_INACTIVE'
      using errcode = 'P0001';
  end if;

  if coalesce(v_med.schedule->>'kind', '') <> 'as_needed' then
    raise exception 'NOT_AS_NEEDED'
      using errcode = 'P0001';
  end if;

  v_now := pg_catalog.now();

  if exists (
    select 1
      from public.dose_events d
     where d.medication_id = v_med.id
       and d.due_at >= v_now - interval '1 second'
  ) then
    raise exception 'DUPLICATE_PRN_DOSE'
      using errcode = 'P0001';
  end if;

  insert into public.dose_events (
    medication_id,
    circle_id,
    due_at,
    status,
    acted_by,
    acted_at
  )
  values (
    v_med.id,
    v_med.circle_id,
    v_now,
    'given'::public.dose_status,
    v_user_id,
    v_now
  )
  returning * into v_dose;

  return v_dose;
end;
$$;

revoke all on function public.log_prn_dose(uuid) from public, anon;
grant execute on function public.log_prn_dose(uuid) to authenticated, service_role;
