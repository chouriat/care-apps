begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(133);

-- Allow non-superuser test roles (anon, authenticated) to record pgTAP results in pg_temp
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

-- Helper: returns visible row count for a table, treating insufficient_privilege (42501) as 0 rows.
create function pg_temp.visible_rows(p_table text) returns integer
language plpgsql
as $$
declare
  n integer;
begin
  execute format('select count(*)::int from public.%I', p_table) into n;
  return n;
exception
  when insufficient_privilege then
    return 0;
end;
$$;

-- Helper: executes an INSERT/UPDATE/DELETE statement and returns true ONLY when the write is blocked
-- (either raises insufficient_privilege 42501, or modifies 0 rows when filtered out by RLS).
create function pg_temp.write_blocked(p_sql text) returns boolean
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
end;
$$;

-- 1-6: Enums match spec (member_role, dose_status, log_type)
select has_enum('public', 'member_role', 'public.member_role enum exists');
select enum_has_labels(
  'public',
  'member_role',
  array['owner', 'helper', 'viewer'],
  'member_role has exact labels (owner, helper, viewer)'
);

select has_enum('public', 'dose_status', 'public.dose_status enum exists');
select enum_has_labels(
  'public',
  'dose_status',
  array['pending', 'given', 'skipped', 'missed'],
  'dose_status has exact labels (pending, given, skipped, missed)'
);

select has_enum('public', 'log_type', 'public.log_type enum exists');
select enum_has_labels(
  'public',
  'log_type',
  array['dose', 'med_change', 'appointment', 'task', 'visit_note', 'member'],
  'log_type has exact labels (dose, med_change, appointment, task, visit_note, member)'
);

-- 7-51: All 9 C1 tables, columns, primary keys, foreign keys, unique constraints, and RLS enabled
-- Table 1: circles
select has_table('public', 'circles', 'public.circles table exists');
select columns_are(
  'public',
  'circles',
  array['id', 'name', 'care_recipient_name', 'care_recipient_dob', 'timezone', 'created_by', 'created_at'],
  'circles columns match C1 spec'
);
select col_is_pk('public', 'circles', 'id', 'circles.id is primary key');
select fk_ok('public', 'circles', 'created_by', 'auth', 'users', 'id', 'circles.created_by references auth.users(id)');
select is(
  coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.circles')), false),
  true,
  'RLS enabled on public.circles'
);

-- Table 2: circle_members
select has_table('public', 'circle_members', 'public.circle_members table exists');
select columns_are(
  'public',
  'circle_members',
  array['circle_id', 'user_id', 'role', 'joined_at'],
  'circle_members columns match C1 spec'
);
select col_is_pk(
  'public',
  'circle_members',
  array['circle_id', 'user_id'],
  '(circle_id, user_id) is primary key on circle_members'
);
select fk_ok('public', 'circle_members', 'circle_id', 'public', 'circles', 'id', 'circle_members.circle_id references circles(id)');
select fk_ok('public', 'circle_members', 'user_id', 'auth', 'users', 'id', 'circle_members.user_id references auth.users(id)');
select is(
  coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.circle_members')), false),
  true,
  'RLS enabled on public.circle_members'
);

-- Table 3: invites
select has_table('public', 'invites', 'public.invites table exists');
select columns_are(
  'public',
  'invites',
  array['id', 'circle_id', 'token', 'role', 'expires_at', 'used_by'],
  'invites columns match C1 spec'
);
select col_is_pk('public', 'invites', 'id', 'invites.id is primary key');
select col_is_unique('public', 'invites', 'token', 'invites.token is unique');
select fk_ok('public', 'invites', 'circle_id', 'public', 'circles', 'id', 'invites.circle_id references circles(id)');
select is(
  coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.invites')), false),
  true,
  'RLS enabled on public.invites'
);

-- Table 4: medications
select has_table('public', 'medications', 'public.medications table exists');
select columns_are(
  'public',
  'medications',
  array['id', 'circle_id', 'name', 'strength', 'dose_text', 'schedule', 'instructions', 'start_date', 'end_date', 'active', 'source'],
  'medications columns match C1 spec'
);
select col_is_pk('public', 'medications', 'id', 'medications.id is primary key');
select fk_ok('public', 'medications', 'circle_id', 'public', 'circles', 'id', 'medications.circle_id references circles(id)');
select col_type_is('public', 'medications', 'schedule', 'jsonb', 'medications.schedule is jsonb');
select is(
  coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.medications')), false),
  true,
  'RLS enabled on public.medications'
);

-- Table 5: dose_events
select has_table('public', 'dose_events', 'public.dose_events table exists');
select columns_are(
  'public',
  'dose_events',
  array['id', 'medication_id', 'circle_id', 'due_at', 'status', 'acted_by', 'acted_at'],
  'dose_events columns match C1 spec'
);
select col_is_pk('public', 'dose_events', 'id', 'dose_events.id is primary key');
select col_is_unique(
  'public',
  'dose_events',
  array['medication_id', 'due_at'],
  'dose_events (medication_id, due_at) is unique'
);
select fk_ok('public', 'dose_events', 'medication_id', 'public', 'medications', 'id', 'dose_events.medication_id references medications(id)');
select fk_ok('public', 'dose_events', 'circle_id', 'public', 'circles', 'id', 'dose_events.circle_id references circles(id)');
select is(
  coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.dose_events')), false),
  true,
  'RLS enabled on public.dose_events'
);

-- Table 6: appointments
select has_table('public', 'appointments', 'public.appointments table exists');
select columns_are(
  'public',
  'appointments',
  array['id', 'circle_id', 'title', 'starts_at', 'ends_at', 'location', 'driver_user_id', 'notes'],
  'appointments columns match C1 spec'
);
select col_is_pk('public', 'appointments', 'id', 'appointments.id is primary key');
select fk_ok('public', 'appointments', 'circle_id', 'public', 'circles', 'id', 'appointments.circle_id references circles(id)');
select is(
  coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.appointments')), false),
  true,
  'RLS enabled on public.appointments'
);

-- Table 7: tasks
select has_table('public', 'tasks', 'public.tasks table exists');
select columns_are(
  'public',
  'tasks',
  array['id', 'circle_id', 'title', 'due_at', 'assignee', 'done_at', 'done_by', 'source'],
  'tasks columns match C1 spec'
);
select col_is_pk('public', 'tasks', 'id', 'tasks.id is primary key');
select fk_ok('public', 'tasks', 'circle_id', 'public', 'circles', 'id', 'tasks.circle_id references circles(id)');
select is(
  coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.tasks')), false),
  true,
  'RLS enabled on public.tasks'
);

-- Table 8: visit_notes
select has_table('public', 'visit_notes', 'public.visit_notes table exists');
select columns_are(
  'public',
  'visit_notes',
  array['id', 'circle_id', 'appointment_id', 'transcript', 'summary', 'created_by', 'created_at'],
  'visit_notes columns match C1 spec'
);
select col_is_pk('public', 'visit_notes', 'id', 'visit_notes.id is primary key');
select fk_ok('public', 'visit_notes', 'circle_id', 'public', 'circles', 'id', 'visit_notes.circle_id references circles(id)');
select fk_ok('public', 'visit_notes', 'appointment_id', 'public', 'appointments', 'id', 'visit_notes.appointment_id references appointments(id)');
select is(
  coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.visit_notes')), false),
  true,
  'RLS enabled on public.visit_notes'
);

-- Table 9: log_entries
select has_table('public', 'log_entries', 'public.log_entries table exists');
select columns_are(
  'public',
  'log_entries',
  array['id', 'circle_id', 'type', 'ref_id', 'summary', 'created_by', 'created_at'],
  'log_entries columns match C1 spec'
);
select col_is_pk('public', 'log_entries', 'id', 'log_entries.id is primary key');
select fk_ok('public', 'log_entries', 'circle_id', 'public', 'circles', 'id', 'log_entries.circle_id references circles(id)');
select is(
  coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.log_entries')), false),
  true,
  'RLS enabled on public.log_entries'
);

-- Seed 4 users (owner, helper, viewer, outsider) and baseline rows across all 9 tables
set local role postgres;

insert into auth.users (
  id,
  instance_id,
  aud,
  role,
  email,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    'c1000001-1111-4111-8111-111111111111'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    'authenticated',
    'authenticated',
    'owner@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    'c1000002-2222-4222-8222-222222222222'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    'authenticated',
    'authenticated',
    'helper@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    'c1000003-3333-4333-8333-333333333333'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    'authenticated',
    'authenticated',
    'viewer@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    'c1000004-4444-4444-8444-444444444444'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    'authenticated',
    'authenticated',
    'outsider@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into public.circles (id, name, care_recipient_name, care_recipient_dob, timezone, created_by)
values (
  'c1c00001-0000-4000-8000-000000000001'::uuid,
  'Mom Care Circle',
  'Evelyn',
  '1948-05-12'::date,
  'America/New_York',
  'c1000001-1111-4111-8111-111111111111'::uuid
);

insert into public.circle_members (circle_id, user_id, role)
values
  ('c1c00001-0000-4000-8000-000000000001'::uuid, 'c1000001-1111-4111-8111-111111111111'::uuid, 'owner'),
  ('c1c00001-0000-4000-8000-000000000001'::uuid, 'c1000002-2222-4222-8222-222222222222'::uuid, 'helper'),
  ('c1c00001-0000-4000-8000-000000000001'::uuid, 'c1000003-3333-4333-8333-333333333333'::uuid, 'viewer');

insert into public.invites (id, circle_id, token, role, expires_at)
values (
  'c1100001-0000-4000-8000-000000000001'::uuid,
  'c1c00001-0000-4000-8000-000000000001'::uuid,
  '5eed000000000000000000000000000000000000000000000000000000000001',
  'helper',
  now() + interval '7 days'
);

insert into public.medications (id, circle_id, name, strength, dose_text, schedule, instructions, start_date, active, source)
values (
  'c1200001-0000-4000-8000-000000000001'::uuid,
  'c1c00001-0000-4000-8000-000000000001'::uuid,
  'Metformin',
  '500 mg',
  '1 tablet',
  '{"kind":"daily","times":["08:00","20:00"]}'::jsonb,
  'Take with food',
  '2026-11-01'::date,
  true,
  'manual'
);

insert into public.dose_events (id, medication_id, circle_id, due_at, status)
values (
  'c1300001-0000-4000-8000-000000000001'::uuid,
  'c1200001-0000-4000-8000-000000000001'::uuid,
  'c1c00001-0000-4000-8000-000000000001'::uuid,
  '2026-11-15T13:00:00Z'::timestamptz,
  'pending'
);

insert into public.appointments (id, circle_id, title, starts_at, ends_at, location, driver_user_id, notes)
values (
  'c1400001-0000-4000-8000-000000000001'::uuid,
  'c1c00001-0000-4000-8000-000000000001'::uuid,
  'Cardiology check-up',
  '2026-11-20T15:00:00Z'::timestamptz,
  '2026-11-20T16:00:00Z'::timestamptz,
  'City Clinic',
  'c1000002-2222-4222-8222-222222222222'::uuid,
  'Bring med list'
);

insert into public.tasks (id, circle_id, title, due_at, assignee, source)
values (
  'c1500001-0000-4000-8000-000000000001'::uuid,
  'c1c00001-0000-4000-8000-000000000001'::uuid,
  'Pick up prescription refill',
  '2026-11-16T17:00:00Z'::timestamptz,
  'c1000002-2222-4222-8222-222222222222'::uuid,
  'manual'
);

insert into public.visit_notes (id, circle_id, appointment_id, transcript, summary, created_by)
values (
  'c1600001-0000-4000-8000-000000000001'::uuid,
  'c1c00001-0000-4000-8000-000000000001'::uuid,
  'c1400001-0000-4000-8000-000000000001'::uuid,
  'Blood pressure is stable.',
  'Continue current regimen and check labs in 2 weeks.',
  'c1000001-1111-4111-8111-111111111111'::uuid
);

-- 52-60: Non-member (anon) reads 0 rows from every C1 table
set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{"role":"anon"}', true);

select is(pg_temp.visible_rows('circles'), 0, 'anon reads 0 rows from circles');
select is(pg_temp.visible_rows('circle_members'), 0, 'anon reads 0 rows from circle_members');
select is(pg_temp.visible_rows('invites'), 0, 'anon reads 0 rows from invites');
select is(pg_temp.visible_rows('medications'), 0, 'anon reads 0 rows from medications');
select is(pg_temp.visible_rows('dose_events'), 0, 'anon reads 0 rows from dose_events');
select is(pg_temp.visible_rows('appointments'), 0, 'anon reads 0 rows from appointments');
select is(pg_temp.visible_rows('tasks'), 0, 'anon reads 0 rows from tasks');
select is(pg_temp.visible_rows('visit_notes'), 0, 'anon reads 0 rows from visit_notes');
select is(pg_temp.visible_rows('log_entries'), 0, 'anon reads 0 rows from log_entries');

-- 61-70: Non-member (authenticated outsider) reads 0 rows from every C1 table and cannot write
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'c1000004-4444-4444-8444-444444444444', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"c1000004-4444-4444-8444-444444444444","role":"authenticated"}',
  true
);

select is(pg_temp.visible_rows('circles'), 0, 'non-member reads 0 rows from circles');
select is(pg_temp.visible_rows('circle_members'), 0, 'non-member reads 0 rows from circle_members');
select is(pg_temp.visible_rows('invites'), 0, 'non-member reads 0 rows from invites');
select is(pg_temp.visible_rows('medications'), 0, 'non-member reads 0 rows from medications');
select is(pg_temp.visible_rows('dose_events'), 0, 'non-member reads 0 rows from dose_events');
select is(pg_temp.visible_rows('appointments'), 0, 'non-member reads 0 rows from appointments');
select is(pg_temp.visible_rows('tasks'), 0, 'non-member reads 0 rows from tasks');
select is(pg_temp.visible_rows('visit_notes'), 0, 'non-member reads 0 rows from visit_notes');
select is(pg_temp.visible_rows('log_entries'), 0, 'non-member reads 0 rows from log_entries');

select throws_ok(
  $$insert into public.medications (circle_id, name, dose_text, schedule, source)
    values ('c1c00001-0000-4000-8000-000000000001'::uuid, 'OutsiderMed', '1 pill', '{"kind":"as_needed"}'::jsonb, 'manual')$$,
  '42501',
  null,
  'non-member cannot insert into medications'
);

-- 71-106: Viewer reads all 9 tables, and viewer INSERT, UPDATE, and DELETE fail on ALL 9 tables
select set_config('request.jwt.claim.sub', 'c1000003-3333-4333-8333-333333333333', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"c1000003-3333-4333-8333-333333333333","role":"authenticated"}',
  true
);

-- 71-79: Viewer can read rows in their circle across all 9 tables
select is(pg_temp.visible_rows('circles'), 1, 'viewer reads circles in their circle');
select is(pg_temp.visible_rows('circle_members'), 3, 'viewer reads circle_members in their circle');
select is(pg_temp.visible_rows('invites'), 0, 'viewer cannot read invite links (owner only: a readable token would let a viewer invite people)');
select is(pg_temp.visible_rows('medications'), 1, 'viewer reads medications in their circle');
select is(pg_temp.visible_rows('dose_events'), 1, 'viewer reads dose_events in their circle');
select is(pg_temp.visible_rows('appointments'), 1, 'viewer reads appointments in their circle');
select is(pg_temp.visible_rows('tasks'), 1, 'viewer reads tasks in their circle');
select is(pg_temp.visible_rows('visit_notes'), 1, 'viewer reads visit_notes in their circle');
select ok(pg_temp.visible_rows('log_entries') >= 1, 'viewer reads log_entries in their circle');

-- 80-88: Viewer INSERT fails on every C1 table
select is(
  pg_temp.write_blocked($$
    insert into public.circles (name, care_recipient_name, timezone, created_by)
    values ('Viewer Circle', 'Bob', 'UTC', 'c1000003-3333-4333-8333-333333333333'::uuid)
  $$),
  true,
  'viewer insert into circles fails'
);

select is(
  pg_temp.write_blocked($$
    insert into public.circle_members (circle_id, user_id, role)
    values ('c1c00001-0000-4000-8000-000000000001'::uuid, 'c1000004-4444-4444-8444-444444444444'::uuid, 'viewer')
  $$),
  true,
  'viewer insert into circle_members fails'
);

select is(
  pg_temp.write_blocked($$
    insert into public.invites (circle_id, role)
    values ('c1c00001-0000-4000-8000-000000000001'::uuid, 'viewer')
  $$),
  true,
  'viewer insert into invites fails'
);

select is(
  pg_temp.write_blocked($$
    insert into public.medications (circle_id, name, dose_text, schedule, source)
    values ('c1c00001-0000-4000-8000-000000000001'::uuid, 'ViewerMed', '1 tab', '{"kind":"as_needed"}'::jsonb, 'manual')
  $$),
  true,
  'viewer insert into medications fails'
);

select is(
  pg_temp.write_blocked($$
    insert into public.dose_events (medication_id, circle_id, due_at, status)
    values ('c1200001-0000-4000-8000-000000000001'::uuid, 'c1c00001-0000-4000-8000-000000000001'::uuid, '2026-11-16T08:00:00Z'::timestamptz, 'given')
  $$),
  true,
  'viewer insert into dose_events fails'
);

select is(
  pg_temp.write_blocked($$
    insert into public.appointments (circle_id, title, starts_at)
    values ('c1c00001-0000-4000-8000-000000000001'::uuid, 'Viewer Appt', '2026-11-21T10:00:00Z'::timestamptz)
  $$),
  true,
  'viewer insert into appointments fails'
);

select is(
  pg_temp.write_blocked($$
    insert into public.tasks (circle_id, title, source)
    values ('c1c00001-0000-4000-8000-000000000001'::uuid, 'Viewer Task', 'manual')
  $$),
  true,
  'viewer insert into tasks fails'
);

select is(
  pg_temp.write_blocked($$
    insert into public.visit_notes (circle_id, transcript, summary, created_by)
    values ('c1c00001-0000-4000-8000-000000000001'::uuid, 'Transcript', 'Summary', 'c1000003-3333-4333-8333-333333333333'::uuid)
  $$),
  true,
  'viewer insert into visit_notes fails'
);

select is(
  pg_temp.write_blocked($$
    insert into public.log_entries (circle_id, type, ref_id, summary, created_by)
    values ('c1c00001-0000-4000-8000-000000000001'::uuid, 'dose', 'c1300001-0000-4000-8000-000000000001'::uuid, 'Forged log', 'c1000003-3333-4333-8333-333333333333'::uuid)
  $$),
  true,
  'viewer insert into log_entries fails'
);

-- 89-97: Viewer UPDATE fails on every C1 table
select is(
  pg_temp.write_blocked($$update public.circles set name = 'Tampered' where id = 'c1c00001-0000-4000-8000-000000000001'::uuid$$),
  true,
  'viewer update on circles fails'
);

select is(
  pg_temp.write_blocked($$update public.circle_members set role = 'owner' where user_id = 'c1000003-3333-4333-8333-333333333333'::uuid$$),
  true,
  'viewer update on circle_members fails'
);

select is(
  pg_temp.write_blocked($$update public.invites set role = 'viewer' where id = 'c1100001-0000-4000-8000-000000000001'::uuid$$),
  true,
  'viewer update on invites fails'
);

select is(
  pg_temp.write_blocked($$update public.medications set name = 'Tampered' where id = 'c1200001-0000-4000-8000-000000000001'::uuid$$),
  true,
  'viewer update on medications fails'
);

select is(
  pg_temp.write_blocked($$update public.dose_events set status = 'given' where id = 'c1300001-0000-4000-8000-000000000001'::uuid$$),
  true,
  'viewer update on dose_events fails'
);

select is(
  pg_temp.write_blocked($$update public.appointments set title = 'Tampered' where id = 'c1400001-0000-4000-8000-000000000001'::uuid$$),
  true,
  'viewer update on appointments fails'
);

select is(
  pg_temp.write_blocked($$update public.tasks set title = 'Tampered' where id = 'c1500001-0000-4000-8000-000000000001'::uuid$$),
  true,
  'viewer update on tasks fails'
);

select is(
  pg_temp.write_blocked($$update public.visit_notes set summary = 'Tampered' where id = 'c1600001-0000-4000-8000-000000000001'::uuid$$),
  true,
  'viewer update on visit_notes fails'
);

select is(
  pg_temp.write_blocked($$update public.log_entries set summary = 'Tampered' where circle_id = 'c1c00001-0000-4000-8000-000000000001'::uuid$$),
  true,
  'viewer update on log_entries fails'
);

-- 98-106: Viewer DELETE fails on every C1 table
select is(
  pg_temp.write_blocked($$delete from public.log_entries where circle_id = 'c1c00001-0000-4000-8000-000000000001'::uuid$$),
  true,
  'viewer delete on log_entries fails'
);

select is(
  pg_temp.write_blocked($$delete from public.visit_notes where id = 'c1600001-0000-4000-8000-000000000001'::uuid$$),
  true,
  'viewer delete on visit_notes fails'
);

select is(
  pg_temp.write_blocked($$delete from public.tasks where id = 'c1500001-0000-4000-8000-000000000001'::uuid$$),
  true,
  'viewer delete on tasks fails'
);

select is(
  pg_temp.write_blocked($$delete from public.appointments where id = 'c1400001-0000-4000-8000-000000000001'::uuid$$),
  true,
  'viewer delete on appointments fails'
);

select is(
  pg_temp.write_blocked($$delete from public.dose_events where id = 'c1300001-0000-4000-8000-000000000001'::uuid$$),
  true,
  'viewer delete on dose_events fails'
);

select is(
  pg_temp.write_blocked($$delete from public.medications where id = 'c1200001-0000-4000-8000-000000000001'::uuid$$),
  true,
  'viewer delete on medications fails'
);

select is(
  pg_temp.write_blocked($$delete from public.invites where id = 'c1100001-0000-4000-8000-000000000001'::uuid$$),
  true,
  'viewer delete on invites fails'
);

select is(
  pg_temp.write_blocked($$delete from public.circle_members where user_id = 'c1000002-2222-4222-8222-222222222222'::uuid$$),
  true,
  'viewer delete on circle_members fails'
);

select is(
  pg_temp.write_blocked($$delete from public.circles where id = 'c1c00001-0000-4000-8000-000000000001'::uuid$$),
  true,
  'viewer delete on circles fails'
);

-- Verify as postgres that viewer write attempts left underlying rows intact
set local role postgres;

select is(
  (select name from public.circles where id = 'c1c00001-0000-4000-8000-000000000001'::uuid),
  'Mom Care Circle',
  'circles row unchanged after viewer write attempts'
);

select is(
  (select role::text from public.circle_members where user_id = 'c1000003-3333-4333-8333-333333333333'::uuid),
  'viewer',
  'viewer role unchanged after viewer self-promotion attempt'
);

select is(
  (select name from public.medications where id = 'c1200001-0000-4000-8000-000000000001'::uuid),
  'Metformin',
  'medications row unchanged after viewer write attempts'
);

-- Helper permissions: cannot create/edit/delete invites, cannot change roles or remove members,
-- cannot delete the circle, but CAN update doses/tasks/meds and triggers write log_entries
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'c1000002-2222-4222-8222-222222222222', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"c1000002-2222-4222-8222-222222222222","role":"authenticated"}',
  true
);

select is(
  pg_temp.write_blocked($$
    insert into public.invites (circle_id, role)
    values ('c1c00001-0000-4000-8000-000000000001'::uuid, 'helper')
  $$),
  true,
  'helper cannot create invites'
);

select is(
  pg_temp.write_blocked($$
    update public.circle_members
       set role = 'helper'
     where circle_id = 'c1c00001-0000-4000-8000-000000000001'::uuid
       and user_id = 'c1000003-3333-4333-8333-333333333333'::uuid
  $$),
  true,
  'helper cannot change member roles'
);

select is(
  pg_temp.write_blocked($$
    delete from public.circle_members
     where circle_id = 'c1c00001-0000-4000-8000-000000000001'::uuid
       and user_id = 'c1000003-3333-4333-8333-333333333333'::uuid
  $$),
  true,
  'helper cannot remove circle members'
);

select is(
  pg_temp.write_blocked($$
    delete from public.circles where id = 'c1c00001-0000-4000-8000-000000000001'::uuid
  $$),
  true,
  'helper cannot delete the circle'
);

-- CC-2b: doses are marked only through set_dose_status (direct UPDATE is revoked).
select lives_ok(
  $$select public.set_dose_status("doseEventId" := 'c1300001-0000-4000-8000-000000000001'::uuid, status := 'given')$$,
  'helper can mark dose_events as given (through set_dose_status)'
);

select lives_ok(
  $$update public.tasks
       set done_at = now(),
           done_by = 'c1000002-2222-4222-8222-222222222222'::uuid
     where id = 'c1500001-0000-4000-8000-000000000001'::uuid$$,
  'helper can mark tasks as completed'
);

select is(
  pg_temp.write_blocked($$update public.log_entries set summary = 'Helper edit' where circle_id = 'c1c00001-0000-4000-8000-000000000001'::uuid$$),
  true,
  'helper cannot update log_entries'
);

-- Owner permissions, constraints, and log_entries append-only immutability (even for owner and postgres)
select set_config('request.jwt.claim.sub', 'c1000001-1111-4111-8111-111111111111', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"c1000001-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);

select lives_ok(
  $$insert into public.invites (circle_id, role)
    values ('c1c00001-0000-4000-8000-000000000001'::uuid, 'helper')$$,
  'owner can create invites (the database makes the token)'
);

select lives_ok(
  $$update public.circle_members
       set role = 'helper'
     where circle_id = 'c1c00001-0000-4000-8000-000000000001'::uuid
       and user_id = 'c1000003-3333-4333-8333-333333333333'::uuid$$,
  'owner can change member roles'
);

select throws_ok(
  $$insert into public.medications (circle_id, name, dose_text, schedule, source)
    values ('c1c00001-0000-4000-8000-000000000001'::uuid, 'BadSource', '1 tab', '{"kind":"as_needed"}'::jsonb, 'invalid')$$,
  '23514',
  null,
  'medications.source check constraint rejects invalid source'
);

select throws_ok(
  $$insert into public.tasks (circle_id, title, source)
    values ('c1c00001-0000-4000-8000-000000000001'::uuid, 'BadSource', 'invalid')$$,
  '23514',
  null,
  'tasks.source check constraint rejects invalid source'
);

select throws_ok(
  $$insert into public.dose_events (medication_id, circle_id, due_at, status)
    values ('c1200001-0000-4000-8000-000000000001'::uuid, 'c1c00001-0000-4000-8000-000000000001'::uuid, '2026-11-15T13:00:00Z'::timestamptz, 'pending')$$,
  '23505',
  null,
  'dose_events unique (medication_id, due_at) rejects duplicate due time'
);

select is(
  pg_temp.write_blocked($$
    insert into public.log_entries (circle_id, type, ref_id, summary, created_by)
    values ('c1c00001-0000-4000-8000-000000000001'::uuid, 'dose', 'c1300001-0000-4000-8000-000000000001'::uuid, 'Owner direct insert', 'c1000001-1111-4111-8111-111111111111'::uuid)
  $$),
  true,
  'owner cannot directly insert into log_entries (insert-only from triggers)'
);

select is(
  pg_temp.write_blocked($$update public.log_entries set summary = 'Owner edit' where circle_id = 'c1c00001-0000-4000-8000-000000000001'::uuid$$),
  true,
  'owner cannot update log_entries'
);

select is(
  pg_temp.write_blocked($$delete from public.log_entries where circle_id = 'c1c00001-0000-4000-8000-000000000001'::uuid$$),
  true,
  'owner cannot delete log_entries'
);

set local role postgres;

select is(
  pg_temp.write_blocked($$update public.log_entries set summary = 'Superuser edit' where circle_id = 'c1c00001-0000-4000-8000-000000000001'::uuid$$),
  true,
  'nobody (even postgres) can update log_entries'
);

select is(
  pg_temp.write_blocked($$delete from public.log_entries where circle_id = 'c1c00001-0000-4000-8000-000000000001'::uuid$$),
  true,
  'nobody (even postgres) can delete log_entries while the circle exists'
);

select results_eq(
  $$select distinct type::text from public.log_entries where circle_id = 'c1c00001-0000-4000-8000-000000000001'::uuid order by 1$$,
  array['appointment', 'dose', 'med_change', 'member', 'task', 'visit_note'],
  'triggers automatically write log_entries for all 6 log_type categories'
);

select * from finish();

rollback;
