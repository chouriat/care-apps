-- CC-2c [safety 1/2]: pgTAP tests for `public.log_prn_dose("medicationId" uuid) returns public.dose_events`.
-- Spec: `docs/spec/carecircle.md` > Dose engine rule 2 ("an `as_needed` medicine has no scheduled
-- doses; the person taps 'Gave a dose now', which records a given dose at the current time").
--
-- Proposed RPC contract for CC-2c [safety 2/2]:
-- - `public.log_prn_dose("medicationId" uuid) returns public.dose_events` (`SECURITY DEFINER`, `set search_path = ''`)
-- - Caller must be authenticated and have role `owner` or `helper` in the medication's circle;
--   unauthenticated callers, `viewer`s, members of other circles, non-members, and unknown/null
--   medication IDs are refused with SQLSTATE `42501` BEFORE checking schedule kind or `active`
--   (so outsiders and viewers never learn anything about a medication).
-- - Refused with SQLSTATE `P0001` and message `MEDICATION_INACTIVE` when `medications.active` is false.
-- - Refused with SQLSTATE `P0001` and message `NOT_AS_NEEDED` when `medications.schedule->>'kind' <> 'as_needed'`.
-- - Two calls in the same second for the same medication: `public.dose_events` has
--   `unique (medication_id, due_at)` and `due_at` / `acted_at` come from the server's `now()`.
--   A second call at the same timestamp (or within the same second, e.g. a double-tap or two phones
--   tapping simultaneously) is refused with SQLSTATE `P0001` and message `DUPLICATE_PRN_DOSE`
--   rather than recording a false double dose or leaking a raw `23505` constraint failure.
--   Earlier PRN doses at prior timestamps (e.g. hours earlier the same day) do not block a new dose at `now()`.
-- - Inserts and returns the `public.dose_events` row with `status = 'given'`, `due_at = now()`,
--   `acted_at = now()`, `acted_by = auth.uid()`.
-- - `audit_dose_events` (`public.write_audit_log_entry()`) writes a `public.log_entries` row with
--   `type = 'dose'`, `ref_id = <dose_events.id>`, `summary = 'Dose marked given'`, and
--   `created_by = auth.uid()`, identical to `public.set_dose_status`.
-- - `mark-missed` never touches PRN rows because their `status` is `'given'` (never `'pending'`).

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(29);

do $$
declare
  temp_schema text := (select nspname from pg_namespace where oid = pg_my_temp_schema());
begin
  if temp_schema is not null then
    execute format('grant usage on schema %I to public', temp_schema);
    execute format('grant all on all tables in schema %I to public', temp_schema);
    execute format('grant all on all sequences in schema %I to public', temp_schema);
  end if;
end;
$$;

create or replace function pg_temp.as_user(p_user_id uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', p_user_id::text, 'role', 'authenticated')::text,
    true
  );
end;
$$;

create or replace function pg_temp.as_postgres()
returns void
language plpgsql
as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- Calls `public.log_prn_dose("medicationId" := p_med)` and returns a compact summary string or
-- `'ERROR <sqlstate>: <sqlerrm>'`. Never raises an uncaught exception so all 26 checks run even
-- before the migration exists on `main`.
create or replace function pg_temp.call_log_prn(p_med uuid)
returns text
language plpgsql
as $$
declare
  r record;
begin
  execute 'select * from public.log_prn_dose("medicationId" := $1)'
    into r using p_med;
  return r.status::text
    || '/' || coalesce(r.medication_id::text, 'null')
    || '/' || coalesce(r.circle_id::text, 'null')
    || '/' || coalesce(r.acted_by::text, 'null')
    || '/' || coalesce((r.due_at = now())::text, 'null')
    || '/' || coalesce((r.acted_at = now())::text, 'null');
exception
  when others then
    return 'ERROR ' || sqlstate || ': ' || sqlerrm;
end;
$$;

grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- 1-6. Function metadata, exact PostgREST parameter name ("medicationId"), return type, search_path, and privileges
select is(
  (select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'log_prn_dose'),
  true,
  '1. public.log_prn_dose is SECURITY DEFINER'
);

select is(
  (select array_to_string(p.proargnames, ',') || ':' || pg_get_function_identity_arguments(p.oid)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'log_prn_dose'),
  'medicationId:"medicationId" uuid',
  '2. public.log_prn_dose signature is ("medicationId" uuid)'
);

select is(
  (select pg_get_function_result(p.oid)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'log_prn_dose'),
  'dose_events',
  '3. public.log_prn_dose returns public.dose_events'
);

select is(
  (select coalesce(p.proconfig, '{}'::text[]) @> array['search_path=""']
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'log_prn_dose'),
  true,
  '4. public.log_prn_dose pins search_path to an empty string'
);

select is(
  (select bool_or(has_function_privilege('anon', p.oid, 'EXECUTE'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'log_prn_dose'),
  false,
  '5. anon role cannot execute public.log_prn_dose'
);

select is(
  (select bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'log_prn_dose'),
  true,
  '6. authenticated role can execute public.log_prn_dose'
);

-- Seed users and circles:
-- Circle A: owner u01, helper u02, viewer u03
-- Circle B: owner u04
-- Outsider: u05
select pg_temp.as_postgres();

insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select ('c2c0000' || n::text || '-0000-4000-8000-00000000000' || n::text)::uuid,
       '00000000-0000-0000-0000-000000000000'::uuid,
       'authenticated',
       'authenticated',
       'cc2c-user-' || n::text || '@example.test',
       '{}'::jsonb,
       '{}'::jsonb,
       now(),
       now()
  from generate_series(1, 5) as n;

insert into public.circles (id, name, care_recipient_name, timezone, created_by)
values
  ('c2cc0001-0000-4000-8000-000000000001'::uuid, 'Circle A', 'Evelyn', 'Europe/Paris', 'c2c00001-0000-4000-8000-000000000001'::uuid),
  ('c2cc0002-0000-4000-8000-000000000002'::uuid, 'Circle B', 'Arthur', 'Europe/London', 'c2c00004-0000-4000-8000-000000000004'::uuid);

insert into public.circle_members (circle_id, user_id, role)
values
  ('c2cc0001-0000-4000-8000-000000000001'::uuid, 'c2c00001-0000-4000-8000-000000000001'::uuid, 'owner'),
  ('c2cc0001-0000-4000-8000-000000000001'::uuid, 'c2c00002-0000-4000-8000-000000000002'::uuid, 'helper'),
  ('c2cc0001-0000-4000-8000-000000000001'::uuid, 'c2c00003-0000-4000-8000-000000000003'::uuid, 'viewer'),
  ('c2cc0002-0000-4000-8000-000000000002'::uuid, 'c2c00004-0000-4000-8000-000000000004'::uuid, 'owner');

-- Medications in Circle A:
-- c2c20001: active as_needed (Paracetamol)
-- c2c20002: active as_needed (Albuterol Inhaler)
-- c2c20003: active as_needed (Lorazepam) with an earlier dose 4 hours ago
-- c2c20004: active daily (Metformin) -> NOT_AS_NEEDED
-- c2c20005: active weekly (Vitamin D) -> NOT_AS_NEEDED
-- c2c20006: inactive as_needed (Ibuprofen) -> MEDICATION_INACTIVE
insert into public.medications (id, circle_id, name, strength, dose_text, schedule, start_date, active, source)
values
  (
    'c2c20001-0000-4000-8000-000000000001'::uuid,
    'c2cc0001-0000-4000-8000-000000000001'::uuid,
    'Paracetamol',
    '500 mg',
    '1 tablet as needed',
    '{"kind":"as_needed"}'::jsonb,
    current_date - 5,
    true,
    'manual'
  ),
  (
    'c2c20002-0000-4000-8000-000000000002'::uuid,
    'c2cc0001-0000-4000-8000-000000000001'::uuid,
    'Albuterol',
    '90 mcg',
    '2 puffs as needed',
    '{"kind":"as_needed"}'::jsonb,
    current_date - 5,
    true,
    'manual'
  ),
  (
    'c2c20003-0000-4000-8000-000000000003'::uuid,
    'c2cc0001-0000-4000-8000-000000000001'::uuid,
    'Lorazepam',
    '0.5 mg',
    '1 tablet as needed',
    '{"kind":"as_needed"}'::jsonb,
    current_date - 5,
    true,
    'manual'
  ),
  (
    'c2c20004-0000-4000-8000-000000000004'::uuid,
    'c2cc0001-0000-4000-8000-000000000001'::uuid,
    'Metformin',
    '500 mg',
    '1 tablet',
    '{"kind":"daily","times":["08:00","20:00"]}'::jsonb,
    current_date - 5,
    true,
    'manual'
  ),
  (
    'c2c20005-0000-4000-8000-000000000005'::uuid,
    'c2cc0001-0000-4000-8000-000000000001'::uuid,
    'Vitamin D',
    '1000 IU',
    '1 capsule',
    '{"kind":"weekly","days":["mon"],"times":["09:00"]}'::jsonb,
    current_date - 5,
    true,
    'manual'
  ),
  (
    'c2c20006-0000-4000-8000-000000000006'::uuid,
    'c2cc0001-0000-4000-8000-000000000001'::uuid,
    'Ibuprofen',
    '200 mg',
    '1 tablet',
    '{"kind":"as_needed"}'::jsonb,
    current_date - 5,
    false,
    'manual'
  );

-- 7-14. Access control refusals (42501)
select pg_temp.as_user('c2c00001-0000-4000-8000-000000000001'::uuid);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);

select matches(
  pg_temp.call_log_prn('c2c20001-0000-4000-8000-000000000001'::uuid),
  '^ERROR 42501:',
  '7. log_prn_dose refuses an unauthenticated caller (null auth.uid()) with 42501'
);

select pg_temp.as_user('c2c00001-0000-4000-8000-000000000001'::uuid);
select matches(
  pg_temp.call_log_prn(null),
  '^ERROR 42501:',
  '8. log_prn_dose refuses a null medicationId with 42501'
);

select matches(
  pg_temp.call_log_prn('c2c29999-0000-4000-8000-000000000099'::uuid),
  '^ERROR 42501:',
  '9. log_prn_dose refuses an unknown medicationId with 42501'
);

select pg_temp.as_user('c2c00003-0000-4000-8000-000000000003'::uuid);
select matches(
  pg_temp.call_log_prn('c2c20001-0000-4000-8000-000000000001'::uuid),
  '^ERROR 42501:',
  '10. log_prn_dose refuses a circle viewer with 42501'
);

select pg_temp.as_user('c2c00004-0000-4000-8000-000000000004'::uuid);
select matches(
  pg_temp.call_log_prn('c2c20001-0000-4000-8000-000000000001'::uuid),
  '^ERROR 42501:',
  '11. log_prn_dose refuses an owner of another circle with 42501'
);

select pg_temp.as_user('c2c00005-0000-4000-8000-000000000005'::uuid);
select matches(
  pg_temp.call_log_prn('c2c20001-0000-4000-8000-000000000001'::uuid),
  '^ERROR 42501:',
  '12. log_prn_dose refuses a non-member with 42501'
);

-- Access check must run before NOT_AS_NEEDED / MEDICATION_INACTIVE so viewers and non-members
-- never learn a medicine's schedule kind or active state from error codes.
select pg_temp.as_user('c2c00003-0000-4000-8000-000000000003'::uuid);
select matches(
  pg_temp.call_log_prn('c2c20004-0000-4000-8000-000000000004'::uuid),
  '^ERROR 42501:',
  '13. viewer calling log_prn_dose on a daily medication gets 42501 (not NOT_AS_NEEDED)'
);

select pg_temp.as_user('c2c00005-0000-4000-8000-000000000005'::uuid);
select matches(
  pg_temp.call_log_prn('c2c20006-0000-4000-8000-000000000006'::uuid),
  '^ERROR 42501:',
  '14. non-member calling log_prn_dose on an inactive medication gets 42501 (not MEDICATION_INACTIVE)'
);

-- 15-18. Schedule kind (NOT_AS_NEEDED) and active state (MEDICATION_INACTIVE) refusals for owner/helper
select pg_temp.as_user('c2c00001-0000-4000-8000-000000000001'::uuid);
select is(
  pg_temp.call_log_prn('c2c20004-0000-4000-8000-000000000004'::uuid),
  'ERROR P0001: NOT_AS_NEEDED',
  '15. log_prn_dose refuses a daily medication with P0001 NOT_AS_NEEDED'
);

select pg_temp.as_user('c2c00002-0000-4000-8000-000000000002'::uuid);
select is(
  pg_temp.call_log_prn('c2c20005-0000-4000-8000-000000000005'::uuid),
  'ERROR P0001: NOT_AS_NEEDED',
  '16. log_prn_dose refuses a weekly medication with P0001 NOT_AS_NEEDED'
);

select pg_temp.as_user('c2c00001-0000-4000-8000-000000000001'::uuid);
select is(
  pg_temp.call_log_prn('c2c20006-0000-4000-8000-000000000006'::uuid),
  'ERROR P0001: MEDICATION_INACTIVE',
  '17. log_prn_dose refuses an inactive as_needed medication with P0001 MEDICATION_INACTIVE'
);

select pg_temp.as_postgres();
select is(
  (select count(*)::int from public.dose_events where circle_id = 'c2cc0001-0000-4000-8000-000000000001'::uuid)
    || '/' ||
  (select count(*)::int from public.log_entries where circle_id = 'c2cc0001-0000-4000-8000-000000000001'::uuid and type = 'dose'),
  '0/0',
  '18. refused log_prn_dose calls insert 0 dose_events rows and 0 dose log_entries rows'
);

-- 19-22. Owner and helper record as-needed doses with status = given, due_at = now(), acted_at = now(), acted_by = auth.uid(), and audit log entry
select pg_temp.as_user('c2c00001-0000-4000-8000-000000000001'::uuid);
select is(
  pg_temp.call_log_prn('c2c20001-0000-4000-8000-000000000001'::uuid),
  'given/c2c20001-0000-4000-8000-000000000001/c2cc0001-0000-4000-8000-000000000001/c2c00001-0000-4000-8000-000000000001/true/true',
  '19. owner records an as_needed dose with status = given, due_at = now(), acted_at = now(), acted_by = auth.uid()'
);

select pg_temp.as_postgres();
select is(
  (select count(*)::int
     from public.log_entries le
     join public.dose_events de on de.id = le.ref_id
    where le.circle_id = 'c2cc0001-0000-4000-8000-000000000001'::uuid
      and le.type = 'dose'
      and le.summary = 'Dose marked given'
      and le.created_by = 'c2c00001-0000-4000-8000-000000000001'::uuid
      and de.medication_id = 'c2c20001-0000-4000-8000-000000000001'::uuid),
  1,
  '20. owner recording a PRN dose writes a dose log_entries row identical in format to set_dose_status'
);

select pg_temp.as_user('c2c00002-0000-4000-8000-000000000002'::uuid);
select is(
  pg_temp.call_log_prn('c2c20002-0000-4000-8000-000000000002'::uuid),
  'given/c2c20002-0000-4000-8000-000000000002/c2cc0001-0000-4000-8000-000000000001/c2c00002-0000-4000-8000-000000000002/true/true',
  '21. helper records an as_needed dose with status = given, due_at = now(), acted_at = now(), acted_by = auth.uid()'
);

select pg_temp.as_postgres();
select is(
  (select count(*)::int
     from public.log_entries le
     join public.dose_events de on de.id = le.ref_id
    where le.circle_id = 'c2cc0001-0000-4000-8000-000000000001'::uuid
      and le.type = 'dose'
      and le.summary = 'Dose marked given'
      and le.created_by = 'c2c00002-0000-4000-8000-000000000002'::uuid
      and de.medication_id = 'c2c20002-0000-4000-8000-000000000002'::uuid),
  1,
  '22. helper recording a PRN dose writes a dose log_entries row authored by the helper'
);

-- 23-25. Two calls in the same second -> clear refusal (DUPLICATE_PRN_DOSE), while an earlier PRN dose hours ago allows a new dose at now()
select pg_temp.as_user('c2c00002-0000-4000-8000-000000000002'::uuid);
select is(
  pg_temp.call_log_prn('c2c20001-0000-4000-8000-000000000001'::uuid),
  'ERROR P0001: DUPLICATE_PRN_DOSE',
  '23. a second log_prn_dose call in the same second for the same medication is refused with P0001 DUPLICATE_PRN_DOSE'
);

select pg_temp.as_postgres();
select is(
  (select count(*)::int from public.dose_events where medication_id = 'c2c20001-0000-4000-8000-000000000001'::uuid)
    || '/' ||
  (select count(*)::int from public.log_entries where circle_id = 'c2cc0001-0000-4000-8000-000000000001'::uuid and type = 'dose'),
  '1/2',
  '24. same-second DUPLICATE_PRN_DOSE refusal leaves dose_events and log_entries counts unchanged'
);

-- Seed an earlier PRN dose 4 hours ago for c2c20003, then verify log_prn_dose at now() succeeds
insert into public.dose_events (id, medication_id, circle_id, due_at, status, acted_by, acted_at)
values (
  'c2cd0001-0000-4000-8000-000000000001'::uuid,
  'c2c20003-0000-4000-8000-000000000003'::uuid,
  'c2cc0001-0000-4000-8000-000000000001'::uuid,
  now() - interval '4 hours',
  'given',
  'c2c00001-0000-4000-8000-000000000001'::uuid,
  now() - interval '4 hours'
);

select pg_temp.as_user('c2c00001-0000-4000-8000-000000000001'::uuid);
-- The call runs in its own statement: a count in the same statement as the call uses that statement's snapshot and can never see the row the call inserts.
select set_config('cc2c.r25', pg_temp.call_log_prn('c2c20003-0000-4000-8000-000000000003'::uuid), true);
select is(
  current_setting('cc2c.r25')
    || '/count=' ||
  (select count(*)::int from public.dose_events where medication_id = 'c2c20003-0000-4000-8000-000000000003'::uuid)::text,
  'given/c2c20003-0000-4000-8000-000000000003/c2cc0001-0000-4000-8000-000000000001/c2c00001-0000-4000-8000-000000000001/true/true/count=2',
  '25. an earlier PRN dose 4 hours ago does not block recording a new PRN dose at now()'
);

-- 26. mark-missed never touches PRN dose_events rows (even those older than 60 minutes) because their status is already 'given'
select pg_temp.as_postgres();
set local role service_role;
update public.dose_events
   set status = 'missed'::public.dose_status
 where circle_id = 'c2cc0001-0000-4000-8000-000000000001'::uuid
   and status = 'pending'::public.dose_status
   and due_at < now() - interval '60 minutes';

select is(
  (select count(*)::int
     from public.dose_events
    where circle_id = 'c2cc0001-0000-4000-8000-000000000001'::uuid
      and status = 'given'::public.dose_status)
    || '/' ||
  (select count(*)::int
     from public.dose_events
    where circle_id = 'c2cc0001-0000-4000-8000-000000000001'::uuid
      and status = 'missed'::public.dose_status),
  '4/0',
  '26. mark-missed query leaves all 4 PRN dose_events rows as given and marks 0 as missed'
);

-- 27-29. Explicit 1-second window across separate transactions (different microseconds):
-- Two phones tapping within 1 second run in separate transactions where `now()` differs by
-- milliseconds, so `unique (medication_id, due_at)` alone would not catch them.
select pg_temp.as_postgres();

insert into public.medications (id, circle_id, name, strength, dose_text, schedule, start_date, active, source)
values
  (
    'c2c20007-0000-4000-8000-000000000007'::uuid,
    'c2cc0001-0000-4000-8000-000000000001'::uuid,
    'Cetirizine',
    '10 mg',
    '1 tablet as needed',
    '{"kind":"as_needed"}'::jsonb,
    current_date - 5,
    true,
    'manual'
  ),
  (
    'c2c20008-0000-4000-8000-000000000008'::uuid,
    'c2cc0001-0000-4000-8000-000000000001'::uuid,
    'Ondansetron',
    '4 mg',
    '1 tablet as needed',
    '{"kind":"as_needed"}'::jsonb,
    current_date - 5,
    true,
    'manual'
  );

insert into public.dose_events (id, medication_id, circle_id, due_at, status, acted_by, acted_at)
values
  (
    'c2cd0007-0000-4000-8000-000000000007'::uuid,
    'c2c20007-0000-4000-8000-000000000007'::uuid,
    'c2cc0001-0000-4000-8000-000000000001'::uuid,
    now() - interval '500 milliseconds',
    'given',
    'c2c00001-0000-4000-8000-000000000001'::uuid,
    now() - interval '500 milliseconds'
  ),
  (
    'c2cd0008-0000-4000-8000-000000000008'::uuid,
    'c2c20008-0000-4000-8000-000000000008'::uuid,
    'c2cc0001-0000-4000-8000-000000000001'::uuid,
    now() - interval '2 seconds',
    'given',
    'c2c00001-0000-4000-8000-000000000001'::uuid,
    now() - interval '2 seconds'
  );

select pg_temp.as_user('c2c00002-0000-4000-8000-000000000002'::uuid);
select is(
  pg_temp.call_log_prn('c2c20007-0000-4000-8000-000000000007'::uuid),
  'ERROR P0001: DUPLICATE_PRN_DOSE',
  '27. log_prn_dose refuses when a given dose was recorded 500 ms ago (different transaction timestamp within 1 second)'
);

select pg_temp.as_postgres();
select is(
  (select count(*)::int from public.dose_events where medication_id = 'c2c20007-0000-4000-8000-000000000007'::uuid),
  1,
  '28. 500 ms DUPLICATE_PRN_DOSE refusal adds no dose_events row'
);

select pg_temp.as_user('c2c00002-0000-4000-8000-000000000002'::uuid);
-- The call runs in its own statement: a count in the same statement as the call uses that statement's snapshot and can never see the row the call inserts.
select set_config('cc2c.r29', pg_temp.call_log_prn('c2c20008-0000-4000-8000-000000000008'::uuid), true);
select is(
  current_setting('cc2c.r29')
    || '/count=' ||
  (select count(*)::int from public.dose_events where medication_id = 'c2c20008-0000-4000-8000-000000000008'::uuid)::text,
  'given/c2c20008-0000-4000-8000-000000000008/c2cc0001-0000-4000-8000-000000000001/c2c00002-0000-4000-8000-000000000002/true/true/count=2',
  '29. log_prn_dose succeeds when the previous given dose was 2 seconds ago'
);

select * from finish();

rollback;
