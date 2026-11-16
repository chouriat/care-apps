-- CC-2b [safety 1/2]: pgTAP tests for `public.set_dose_status("doseEventId", status)`,
-- direct `public.dose_events` UPDATE revocation for `authenticated` (while preserving
-- `service_role` for `mark-missed`), the `carecircle-mark-missed` `pg_cron` schedule
-- (`*/5 * * * *` reading `project_url` and `cron_secret` from Vault), and `public.dose_events`
-- in the `supabase_realtime` publication.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(39);

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

create or replace function pg_temp.write_blocked(p_sql text)
returns boolean
language plpgsql
as $$
declare
  affected integer;
begin
  execute p_sql;
  get diagnostics affected = row_count;
  return affected = 0;
exception
  when insufficient_privilege then
    return true;
  when others then
    return true;
end;
$$;

-- Calls set_dose_status as the current role and returns 'status/acted_by/acted_at is now', or the
-- error. Never raises, so one failing check (or a missing function on main) cannot abort the file.
create or replace function pg_temp.set_status(p_dose uuid, p_status public.dose_status)
returns text
language plpgsql
as $$
declare
  r record;
begin
  execute 'select * from public.set_dose_status("doseEventId" := $1, status := $2)'
    into r using p_dose, p_status;
  return r.status::text || '/' || coalesce(r.acted_by::text, 'null') || '/'
    || coalesce((r.acted_at between now() - interval '1 minute' and now() + interval '1 minute')::text, 'null');
exception
  when others then
    return 'ERROR ' || sqlstate || ': ' || sqlerrm;
end;
$$;

grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- 1-6. Function metadata, exact PostgREST parameter names ("doseEventId", status), search_path, and privileges
select is(
  (select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'set_dose_status'),
  true,
  'public.set_dose_status is SECURITY DEFINER'
);

select is(
  (select p.pronargs::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'set_dose_status'),
  2,
  'public.set_dose_status takes exactly 2 arguments ("doseEventId" uuid, status dose_status)'
);

select is(
  (select array_to_string(p.proargnames, ',') || ':' || pg_get_function_identity_arguments(p.oid)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'set_dose_status'),
  'doseEventId,status:"doseEventId" uuid, status dose_status',
  'set_dose_status("doseEventId" uuid, status dose_status): argument names match the app''s RPC call (spec APIs)'
);

select is(
  (select coalesce(p.proconfig, '{}'::text[]) @> array['search_path=""']
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'set_dose_status'),
  true,
  'public.set_dose_status pins search_path to an empty string'
);

select is(
  (select bool_or(has_function_privilege('anon', p.oid, 'EXECUTE'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'set_dose_status'),
  false,
  'anon role cannot execute set_dose_status'
);

select is(
  (select bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'set_dose_status'),
  true,
  'authenticated role can execute set_dose_status'
);

-- Seed users: Circle A (owner u01, helper u02, viewer u03), Circle B (owner u04), outsider (u05)
select pg_temp.as_postgres();

insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select ('c2b0000' || n::text || '-0000-4000-8000-00000000000' || n::text)::uuid,
       '00000000-0000-0000-0000-000000000000'::uuid,
       'authenticated',
       'authenticated',
       'cc2b-user-' || n::text || '@example.test',
       '{}'::jsonb,
       '{}'::jsonb,
       now(),
       now()
  from generate_series(1, 5) as n;

insert into public.circles (id, name, care_recipient_name, timezone, created_by)
values
  ('c2bc0001-0000-4000-8000-000000000001'::uuid, 'Circle A', 'Evelyn', 'Europe/Paris', 'c2b00001-0000-4000-8000-000000000001'::uuid),
  ('c2bc0002-0000-4000-8000-000000000002'::uuid, 'Circle B', 'Arthur', 'Europe/London', 'c2b00004-0000-4000-8000-000000000004'::uuid);

insert into public.circle_members (circle_id, user_id, role)
values
  ('c2bc0001-0000-4000-8000-000000000001'::uuid, 'c2b00001-0000-4000-8000-000000000001'::uuid, 'owner'),
  ('c2bc0001-0000-4000-8000-000000000001'::uuid, 'c2b00002-0000-4000-8000-000000000002'::uuid, 'helper'),
  ('c2bc0001-0000-4000-8000-000000000001'::uuid, 'c2b00003-0000-4000-8000-000000000003'::uuid, 'viewer'),
  ('c2bc0002-0000-4000-8000-000000000002'::uuid, 'c2b00004-0000-4000-8000-000000000004'::uuid, 'owner');

insert into public.medications (id, circle_id, name, strength, dose_text, schedule, start_date, active, source)
values (
  'c2b20001-0000-4000-8000-000000000001'::uuid,
  'c2bc0001-0000-4000-8000-000000000001'::uuid,
  'Metformin',
  '500 mg',
  '1 tablet',
  '{"kind":"daily","times":["08:00","12:00","16:00","20:00","22:00"]}'::jsonb,
  current_date - 5,
  true,
  'manual'
);

insert into public.dose_events (id, medication_id, circle_id, due_at, status)
values
  ('c2bd0001-0000-4000-8000-000000000001'::uuid, 'c2b20001-0000-4000-8000-000000000001'::uuid, 'c2bc0001-0000-4000-8000-000000000001'::uuid, '2026-11-15T08:00:00Z'::timestamptz, 'pending'),
  ('c2bd0002-0000-4000-8000-000000000002'::uuid, 'c2b20001-0000-4000-8000-000000000001'::uuid, 'c2bc0001-0000-4000-8000-000000000001'::uuid, '2026-11-15T12:00:00Z'::timestamptz, 'pending'),
  ('c2bd0003-0000-4000-8000-000000000003'::uuid, 'c2b20001-0000-4000-8000-000000000001'::uuid, 'c2bc0001-0000-4000-8000-000000000001'::uuid, '2026-11-15T16:00:00Z'::timestamptz, 'pending'),
  ('c2bd0004-0000-4000-8000-000000000004'::uuid, 'c2b20001-0000-4000-8000-000000000001'::uuid, 'c2bc0001-0000-4000-8000-000000000001'::uuid, '2026-11-15T20:00:00Z'::timestamptz, 'pending'),
  ('c2bd0005-0000-4000-8000-000000000005'::uuid, 'c2b20001-0000-4000-8000-000000000001'::uuid, 'c2bc0001-0000-4000-8000-000000000001'::uuid, '2026-11-15T22:00:00Z'::timestamptz, 'pending');

-- 7-15. Refusals: null auth.uid(), status = pending/missed/null, viewer, other circle owner, non-member, unknown dose id
select pg_temp.as_user('c2b00001-0000-4000-8000-000000000001'::uuid);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);

select throws_ok(
  $$select public.set_dose_status("doseEventId" := 'c2bd0001-0000-4000-8000-000000000001'::uuid, status := 'given'::public.dose_status)$$,
  '42501',
  null,
  'set_dose_status refuses an unauthenticated caller (null auth.uid())'
);

select pg_temp.as_user('c2b00001-0000-4000-8000-000000000001'::uuid);
select throws_ok(
  $$select public.set_dose_status("doseEventId" := 'c2bd0001-0000-4000-8000-000000000001'::uuid, status := 'pending'::public.dose_status)$$,
  '22023',
  null,
  'set_dose_status refuses status = pending'
);

select throws_ok(
  $$select public.set_dose_status("doseEventId" := 'c2bd0001-0000-4000-8000-000000000001'::uuid, status := 'missed'::public.dose_status)$$,
  '22023',
  null,
  'set_dose_status refuses status = missed (only given or skipped allowed)'
);

select throws_ok(
  $$select public.set_dose_status("doseEventId" := 'c2bd0001-0000-4000-8000-000000000001'::uuid, status := null)$$,
  '22023',
  null,
  'set_dose_status refuses null status'
);

-- Viewer of Circle A is refused
select pg_temp.as_user('c2b00003-0000-4000-8000-000000000003'::uuid);
select throws_ok(
  $$select public.set_dose_status("doseEventId" := 'c2bd0001-0000-4000-8000-000000000001'::uuid, status := 'given'::public.dose_status)$$,
  '42501',
  null,
  'set_dose_status refuses a circle viewer'
);

-- Owner of Circle B (another circle) is refused on Circle A's dose
select pg_temp.as_user('c2b00004-0000-4000-8000-000000000004'::uuid);
select throws_ok(
  $$select public.set_dose_status("doseEventId" := 'c2bd0001-0000-4000-8000-000000000001'::uuid, status := 'given'::public.dose_status)$$,
  '42501',
  null,
  'set_dose_status refuses an owner of another circle'
);

-- Non-member (outsider) is refused
select pg_temp.as_user('c2b00005-0000-4000-8000-000000000005'::uuid);
select throws_ok(
  $$select public.set_dose_status("doseEventId" := 'c2bd0001-0000-4000-8000-000000000001'::uuid, status := 'given'::public.dose_status)$$,
  '42501',
  null,
  'set_dose_status refuses a non-member'
);

-- Unknown doseEventId is refused
select pg_temp.as_user('c2b00001-0000-4000-8000-000000000001'::uuid);
select throws_ok(
  $$select public.set_dose_status("doseEventId" := 'c2bd9999-0000-4000-8000-000000000099'::uuid, status := 'given'::public.dose_status)$$,
  '42501',
  null,
  'set_dose_status refuses an unknown doseEventId'
);

select pg_temp.as_postgres();
select is(
  (select status::text || '/' || (acted_by is null)::text from public.dose_events where id = 'c2bd0001-0000-4000-8000-000000000001'::uuid)
    || '/' ||
  (select count(*)::int from public.log_entries where circle_id = 'c2bc0001-0000-4000-8000-000000000001'::uuid and type = 'dose'),
  'pending/true/0',
  'refused set_dose_status calls leave the dose pending and write 0 dose log entries'
);

-- 16-20. Owner and helper record pending doses as given and skipped
select pg_temp.as_user('c2b00001-0000-4000-8000-000000000001'::uuid);
select is(
  pg_temp.set_status('c2bd0001-0000-4000-8000-000000000001'::uuid, 'given'),
  'given/c2b00001-0000-4000-8000-000000000001/true',
  'owner sets a pending dose to given with acted_by = auth.uid() and acted_at = now()'
);

select is(
  (select count(*)::int from public.log_entries
    where circle_id = 'c2bc0001-0000-4000-8000-000000000001'::uuid
      and type = 'dose'
      and ref_id = 'c2bd0001-0000-4000-8000-000000000001'::uuid
      and created_by = 'c2b00001-0000-4000-8000-000000000001'::uuid),
  1,
  'owner setting dose to given writes exactly one dose log line authored by the owner'
);

select pg_temp.as_user('c2b00002-0000-4000-8000-000000000002'::uuid);
select is(
  pg_temp.set_status('c2bd0002-0000-4000-8000-000000000002'::uuid, 'skipped'),
  'skipped/c2b00002-0000-4000-8000-000000000002/true',
  'helper sets a pending dose to skipped with acted_by = auth.uid() and acted_at = now()'
);

select is(
  (select count(*)::int from public.log_entries
    where circle_id = 'c2bc0001-0000-4000-8000-000000000001'::uuid
      and type = 'dose'
      and ref_id = 'c2bd0002-0000-4000-8000-000000000002'::uuid
      and created_by = 'c2b00002-0000-4000-8000-000000000002'::uuid),
  1,
  'helper setting dose to skipped writes_audit_log_entry authored by the helper'
);

-- 20-23. A dose already given or skipped is refused with DOSE_ALREADY_RECORDED and left unchanged
select pg_temp.as_user('c2b00002-0000-4000-8000-000000000002'::uuid);
select throws_matching(
  $$select public.set_dose_status("doseEventId" := 'c2bd0001-0000-4000-8000-000000000001'::uuid, status := 'skipped'::public.dose_status)$$,
  'DOSE_ALREADY_RECORDED',
  'a dose already given is refused with DOSE_ALREADY_RECORDED when another carer tries to mark it skipped'
);

select throws_matching(
  $$select public.set_dose_status("doseEventId" := 'c2bd0001-0000-4000-8000-000000000001'::uuid, status := 'given'::public.dose_status)$$,
  'DOSE_ALREADY_RECORDED',
  'a dose already given is refused with DOSE_ALREADY_RECORDED when marked given a second time'
);

select pg_temp.as_user('c2b00001-0000-4000-8000-000000000001'::uuid);
select throws_matching(
  $$select public.set_dose_status("doseEventId" := 'c2bd0002-0000-4000-8000-000000000002'::uuid, status := 'given'::public.dose_status)$$,
  'DOSE_ALREADY_RECORDED',
  'a dose already skipped is refused with DOSE_ALREADY_RECORDED when another carer tries to mark it given'
);

select pg_temp.as_postgres();
select is(
  (select status::text || '/' || acted_by::text from public.dose_events where id = 'c2bd0001-0000-4000-8000-000000000001'::uuid)
    || '/' ||
  (select status::text || '/' || acted_by::text from public.dose_events where id = 'c2bd0002-0000-4000-8000-000000000002'::uuid)
    || '/' ||
  (select count(*)::int from public.log_entries where circle_id = 'c2bc0001-0000-4000-8000-000000000001'::uuid and type = 'dose'),
  'given/c2b00001-0000-4000-8000-000000000001/skipped/c2b00002-0000-4000-8000-000000000002/2',
  'DOSE_ALREADY_RECORDED refusals leave status, acted_by, and dose log count unchanged'
);

-- A viewer, an owner of another circle and a non-member get the same 42501 refusal on a dose
-- that is already recorded: DOSE_ALREADY_RECORDED is checked only after access, so it never tells
-- an outsider anything about another family's doses.
select pg_temp.as_user('c2b00003-0000-4000-8000-000000000003'::uuid);
select matches(
  pg_temp.set_status('c2bd0001-0000-4000-8000-000000000001'::uuid, 'skipped'),
  '^ERROR 42501',
  'a viewer is refused with 42501 (not DOSE_ALREADY_RECORDED) on an already recorded dose'
);

select pg_temp.as_user('c2b00004-0000-4000-8000-000000000004'::uuid);
select matches(
  pg_temp.set_status('c2bd0001-0000-4000-8000-000000000001'::uuid, 'skipped'),
  '^ERROR 42501',
  'an owner of another circle is refused with 42501 (not DOSE_ALREADY_RECORDED) on an already recorded dose'
);

select pg_temp.as_user('c2b00005-0000-4000-8000-000000000005'::uuid);
select matches(
  pg_temp.set_status('c2bd0001-0000-4000-8000-000000000001'::uuid, 'skipped'),
  '^ERROR 42501',
  'a non-member is refused with 42501 (not DOSE_ALREADY_RECORDED) on an already recorded dose'
);

-- 24-27. mark-missed (service_role) can set pending -> missed, and a missed dose can still be recorded late as given or skipped
set local role service_role;
update public.dose_events
   set status = 'missed'::public.dose_status
 where id in ('c2bd0003-0000-4000-8000-000000000003'::uuid, 'c2bd0004-0000-4000-8000-000000000004'::uuid)
   and status = 'pending'::public.dose_status;

select is(
  (select count(*)::int from public.dose_events
    where id in ('c2bd0003-0000-4000-8000-000000000003'::uuid, 'c2bd0004-0000-4000-8000-000000000004'::uuid)
      and status = 'missed'::public.dose_status
      and acted_by is null),
  2,
  'service_role (mark-missed) can update pending dose_events to missed with acted_by = null'
);

select pg_temp.as_user('c2b00002-0000-4000-8000-000000000002'::uuid);
select is(
  pg_temp.set_status('c2bd0003-0000-4000-8000-000000000003'::uuid, 'given'),
  'given/c2b00002-0000-4000-8000-000000000002/true',
  'a dose that is already missed can still be set to given (late record)'
);

select pg_temp.as_user('c2b00001-0000-4000-8000-000000000001'::uuid);
select is(
  pg_temp.set_status('c2bd0004-0000-4000-8000-000000000004'::uuid, 'skipped'),
  'skipped/c2b00001-0000-4000-8000-000000000001/true',
  'a dose that is already missed can still be set to skipped (late record)'
);

select throws_matching(
  $$select public.set_dose_status("doseEventId" := 'c2bd0003-0000-4000-8000-000000000003'::uuid, status := 'skipped'::public.dose_status)$$,
  'DOSE_ALREADY_RECORDED',
  'once a missed dose has been recorded late as given, a second attempt is refused with DOSE_ALREADY_RECORDED'
);

-- 28-30. Direct UPDATE on public.dose_events as authenticated is blocked (even for owner and helper)
select pg_temp.as_user('c2b00001-0000-4000-8000-000000000001'::uuid);
select is(
  pg_temp.write_blocked($$
    update public.dose_events
       set status = 'given'::public.dose_status,
           acted_by = 'c2b00001-0000-4000-8000-000000000001'::uuid,
           acted_at = now()
     where id = 'c2bd0005-0000-4000-8000-000000000005'::uuid
  $$),
  true,
  'authenticated circle owner cannot directly UPDATE public.dose_events (must use set_dose_status RPC)'
);

select pg_temp.as_user('c2b00002-0000-4000-8000-000000000002'::uuid);
select is(
  pg_temp.write_blocked($$
    update public.dose_events
       set status = 'skipped'::public.dose_status,
           acted_by = 'c2b00002-0000-4000-8000-000000000002'::uuid,
           acted_at = now()
     where id = 'c2bd0005-0000-4000-8000-000000000005'::uuid
  $$),
  true,
  'authenticated circle helper cannot directly UPDATE public.dose_events (must use set_dose_status RPC)'
);

select pg_temp.as_postgres();
select is(
  (select status::text from public.dose_events where id = 'c2bd0005-0000-4000-8000-000000000005'::uuid),
  'pending',
  'dose c2bd0005 remains pending after blocked direct UPDATE attempts'
);

-- Revoking direct UPDATE must not take away reading: every member of Circle A still reads its 5 doses.
select pg_temp.as_user('c2b00001-0000-4000-8000-000000000001'::uuid);
select is(
  (select count(*)::int from public.dose_events where circle_id = 'c2bc0001-0000-4000-8000-000000000001'::uuid),
  5,
  'the owner still reads all 5 of the circle''s doses after direct UPDATE is revoked'
);

select pg_temp.as_user('c2b00003-0000-4000-8000-000000000003'::uuid);
select is(
  (select count(*)::int from public.dose_events where circle_id = 'c2bc0001-0000-4000-8000-000000000001'::uuid),
  5,
  'the viewer still reads all 5 of the circle''s doses'
);

select pg_temp.as_postgres();
-- 31-33. pg_cron schedule for carecircle-mark-missed (*/5 * * * *) reading project_url and cron_secret from Vault
select is(
  (select schedule || '/' || active::text from cron.job where jobname = 'carecircle-mark-missed'),
  '*/5 * * * */true',
  'cron.job has carecircle-mark-missed scheduled at */5 * * * * and active'
);

select ok(
  (select command ~* '/functions/v1/mark-missed' from cron.job where jobname = 'carecircle-mark-missed'),
  'carecircle-mark-missed cron command posts to /functions/v1/mark-missed'
);

select ok(
  (select command ~* 'vault\.decrypted_secrets' and command ~* 'project_url' and command ~* 'cron_secret'
          and command ~* 'Bearer'
     from cron.job where jobname = 'carecircle-mark-missed'),
  'carecircle-mark-missed cron command reads project_url and cron_secret from vault.decrypted_secrets'
);

-- 34. Realtime publication: public.dose_events is in supabase_realtime
select is(
  (select count(*)::int from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'dose_events'),
  1,
  'public.dose_events is in the supabase_realtime publication'
);

select * from finish();

rollback;
