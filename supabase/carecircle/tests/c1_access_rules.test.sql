-- CC-0 [safety]: contract C1 field by field, and the access rules the first file does not reach.
-- Two families (circle A and circle B), so "a non-member reads 0 rows" also means
-- "a member of ANOTHER circle reads 0 rows", which is the case that matters in production.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(97);

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

-- Switch to a signed-in user (or back to postgres with null).
create function pg_temp.login(p_user uuid) returns void
language plpgsql
as $$
begin
  if p_user is null then
    execute 'set local role postgres';
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    return;
  end if;
  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end;
$$;

-- Rows of one circle visible to the current user in one table (refused read counts as 0).
create function pg_temp.rows_in(p_table text, p_circle uuid) returns integer
language plpgsql
as $$
declare
  n integer;
  col text := case when p_table = 'circles' then 'id' else 'circle_id' end;
begin
  execute format('select count(*)::int from public.%I where %I = $1', p_table, col) into n using p_circle;
  return n;
exception
  when insufficient_privilege then
    return 0;
end;
$$;

-- Rows of one circle visible in all 9 C1 tables together.
create function pg_temp.rows_everywhere(p_circle uuid) returns integer
language sql
as $$
  select sum(pg_temp.rows_in(t, p_circle))::int
  from unnest(array['circles', 'circle_members', 'invites', 'medications', 'dose_events',
                    'appointments', 'tasks', 'visit_notes', 'log_entries']) as t
$$;

-- Rows a write changed; -1 when refused with 42501 (permission or RLS check).
create function pg_temp.write_count(p_sql text) returns integer
language plpgsql
as $$
declare
  affected integer;
begin
  execute p_sql;
  get diagnostics affected = row_count;
  return affected;
exception
  when insufficient_privilege then
    return -1;
end;
$$;

-- True when a write changed nothing, whatever the reason (RLS, privilege, check, trigger).
create function pg_temp.write_refused(p_sql text) returns boolean
language plpgsql
as $$
declare
  affected integer;
begin
  execute p_sql;
  get diagnostics affected = row_count;
  return affected = 0;
exception
  when others then
    return true;
end;
$$;

-- every C1 column has the spec's type (columns_are in the first file checks only names)
create function pg_temp.column_types(p_table text) returns text
language sql
as $$
  select string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod), ', ' order by a.attname)
  from pg_attribute a
  where a.attrelid = ('public.' || p_table)::regclass and a.attnum > 0 and not a.attisdropped
$$;

select is(pg_temp.column_types('circles'),
  'care_recipient_dob date, care_recipient_name text, created_at timestamp with time zone, created_by uuid, id uuid, name text, timezone text',
  'circles column types match C1');
select is(pg_temp.column_types('circle_members'),
  'circle_id uuid, joined_at timestamp with time zone, role member_role, user_id uuid',
  'circle_members column types match C1');
select is(pg_temp.column_types('invites'),
  'circle_id uuid, expires_at timestamp with time zone, id uuid, role member_role, token text, used_by uuid',
  'invites column types match C1');
select is(pg_temp.column_types('medications'),
  'active boolean, circle_id uuid, dose_text text, end_date date, id uuid, instructions text, name text, schedule jsonb, source text, start_date date, strength text',
  'medications column types match C1');
select is(pg_temp.column_types('dose_events'),
  'acted_at timestamp with time zone, acted_by uuid, circle_id uuid, due_at timestamp with time zone, id uuid, medication_id uuid, status dose_status',
  'dose_events column types match C1');
select is(pg_temp.column_types('appointments'),
  'circle_id uuid, driver_user_id uuid, ends_at timestamp with time zone, id uuid, location text, notes text, starts_at timestamp with time zone, title text',
  'appointments column types match C1');
select is(pg_temp.column_types('tasks'),
  'assignee uuid, circle_id uuid, done_at timestamp with time zone, done_by uuid, due_at timestamp with time zone, id uuid, source text, title text',
  'tasks column types match C1');
select is(pg_temp.column_types('visit_notes'),
  'appointment_id uuid, circle_id uuid, created_at timestamp with time zone, created_by uuid, id uuid, summary text, transcript text',
  'visit_notes column types match C1');
select is(pg_temp.column_types('log_entries'),
  'circle_id uuid, created_at timestamp with time zone, created_by uuid, id uuid, ref_id uuid, summary text, type log_type',
  'log_entries column types match C1');

-- required columns are NOT NULL; columns the spec marks "null" accept null
select is(
  (select array_agg(c order by c) from unnest(array[
     'circles.name', 'circles.care_recipient_name', 'circles.timezone', 'circles.created_at',
     'circle_members.circle_id', 'circle_members.user_id', 'circle_members.role', 'circle_members.joined_at',
     'invites.circle_id', 'invites.token', 'invites.role', 'invites.expires_at',
     'medications.circle_id', 'medications.name', 'medications.dose_text', 'medications.schedule',
     'medications.active', 'medications.source',
     'dose_events.medication_id', 'dose_events.circle_id', 'dose_events.due_at', 'dose_events.status',
     'appointments.circle_id', 'appointments.title', 'appointments.starts_at',
     'tasks.circle_id', 'tasks.title', 'tasks.source',
     'visit_notes.circle_id', 'visit_notes.created_at',
     'log_entries.circle_id', 'log_entries.type', 'log_entries.created_at'
   ]) as c
   where not exists (
     select 1 from pg_attribute a
     where a.attrelid = ('public.' || split_part(c, '.', 1))::regclass
       and a.attname = split_part(c, '.', 2) and a.attnotnull)),
  null::text[],
  'every required C1 column is NOT NULL (lists any that are not)'
);
select is(
  (select array_agg(c order by c) from unnest(array[
     'circles.care_recipient_dob', 'invites.used_by', 'medications.strength', 'medications.instructions',
     'medications.end_date', 'dose_events.acted_by', 'dose_events.acted_at', 'appointments.ends_at',
     'appointments.location', 'appointments.driver_user_id', 'appointments.notes', 'tasks.due_at',
     'tasks.assignee', 'tasks.done_at', 'tasks.done_by', 'visit_notes.appointment_id'
   ]) as c
   where exists (
     select 1 from pg_attribute a
     where a.attrelid = ('public.' || split_part(c, '.', 1))::regclass
       and a.attname = split_part(c, '.', 2) and a.attnotnull)),
  null::text[],
  'every C1 column the spec marks "null" is nullable (lists any that are not)'
);

-- Seed: two families. Circle A: owner, helper, viewer. Circle B: another family's owner.
-- A fifth user belongs to no circle.
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select u.id, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', u.email,
       '{}'::jsonb, '{}'::jsonb, now(), now()
from (values
  ('aa000001-0000-4000-8000-000000000001'::uuid, 'a-owner@example.test'),
  ('aa000002-0000-4000-8000-000000000002'::uuid, 'a-helper@example.test'),
  ('aa000003-0000-4000-8000-000000000003'::uuid, 'a-viewer@example.test'),
  ('bb000001-0000-4000-8000-000000000001'::uuid, 'b-owner@example.test'),
  ('cc000001-0000-4000-8000-000000000001'::uuid, 'no-circle@example.test')
) as u(id, email);

insert into public.circles (id, name, care_recipient_name, timezone, created_by) values
  ('a0c00000-0000-4000-8000-000000000001', 'Family A', 'Grandma A', 'Europe/Paris', 'aa000001-0000-4000-8000-000000000001'),
  ('b0c00000-0000-4000-8000-000000000001', 'Family B', 'Grandpa B', 'America/Chicago', 'bb000001-0000-4000-8000-000000000001');

insert into public.circle_members (circle_id, user_id, role) values
  ('a0c00000-0000-4000-8000-000000000001', 'aa000001-0000-4000-8000-000000000001', 'owner'),
  ('a0c00000-0000-4000-8000-000000000001', 'aa000002-0000-4000-8000-000000000002', 'helper'),
  ('a0c00000-0000-4000-8000-000000000001', 'aa000003-0000-4000-8000-000000000003', 'viewer'),
  ('b0c00000-0000-4000-8000-000000000001', 'bb000001-0000-4000-8000-000000000001', 'owner');

insert into public.invites (id, circle_id, token, role, expires_at) values
  ('a0100000-0000-4000-8000-000000000001', 'a0c00000-0000-4000-8000-000000000001',
   'a0000000000000000000000000000000000000000000000000000000000000a1', 'viewer', now() + interval '7 days'),
  ('b0100000-0000-4000-8000-000000000001', 'b0c00000-0000-4000-8000-000000000001',
   'b0000000000000000000000000000000000000000000000000000000000000b1', 'helper', now() + interval '7 days');

insert into public.medications (id, circle_id, name, dose_text, schedule, start_date, source) values
  ('a0200000-0000-4000-8000-000000000001', 'a0c00000-0000-4000-8000-000000000001', 'Med A', '1 tablet',
   '{"kind":"daily","times":["08:00"]}', '2026-11-01', 'manual'),
  ('b0200000-0000-4000-8000-000000000001', 'b0c00000-0000-4000-8000-000000000001', 'Med B', '1 tablet',
   '{"kind":"as_needed"}', '2026-11-01', 'photo');

insert into public.dose_events (id, medication_id, circle_id, due_at) values
  ('a0300000-0000-4000-8000-000000000001', 'a0200000-0000-4000-8000-000000000001',
   'a0c00000-0000-4000-8000-000000000001', '2026-11-15T07:00:00Z'),
  ('b0300000-0000-4000-8000-000000000001', 'b0200000-0000-4000-8000-000000000001',
   'b0c00000-0000-4000-8000-000000000001', '2026-11-15T14:00:00Z');

insert into public.appointments (id, circle_id, title, starts_at) values
  ('a0400000-0000-4000-8000-000000000001', 'a0c00000-0000-4000-8000-000000000001', 'Appt A', '2026-11-20T09:00:00Z'),
  ('b0400000-0000-4000-8000-000000000001', 'b0c00000-0000-4000-8000-000000000001', 'Appt B', '2026-11-20T10:00:00Z');

insert into public.tasks (id, circle_id, title, source) values
  ('a0500000-0000-4000-8000-000000000001', 'a0c00000-0000-4000-8000-000000000001', 'Task A', 'manual'),
  ('b0500000-0000-4000-8000-000000000001', 'b0c00000-0000-4000-8000-000000000001', 'Task B', 'manual');

insert into public.visit_notes (id, circle_id, appointment_id, transcript, summary, created_by) values
  ('a0600000-0000-4000-8000-000000000001', 'a0c00000-0000-4000-8000-000000000001',
   'a0400000-0000-4000-8000-000000000001', 'Transcript A', 'Summary A', 'aa000001-0000-4000-8000-000000000001'),
  ('b0600000-0000-4000-8000-000000000001', 'b0c00000-0000-4000-8000-000000000001',
   'b0400000-0000-4000-8000-000000000001', 'Transcript B', 'Summary B', 'bb000001-0000-4000-8000-000000000001');

-- spec defaults (dose status pending, medication active, invite role helper) and schedule check
select is((select status::text from public.dose_events where id = 'a0300000-0000-4000-8000-000000000001'),
  'pending', 'dose_events.status defaults to pending');
select is((select active from public.medications where id = 'a0200000-0000-4000-8000-000000000001'),
  true, 'medications.active defaults to true');
select ok(
  pg_temp.write_refused($$insert into public.medications (circle_id, name, dose_text, schedule, source)
    values ('a0c00000-0000-4000-8000-000000000001', 'Bad', '1', '{"kind":"monthly"}', 'manual')$$),
  'the database refuses a schedule with an unknown kind, even from the server');
select ok(
  pg_temp.write_refused($$insert into public.medications (circle_id, name, dose_text, schedule, source)
    values ('a0c00000-0000-4000-8000-000000000001', 'Bad', '1', '["daily"]', 'manual')$$),
  'the database refuses a schedule that is not a JSON object');

-- a circle has exactly one owner, enforced by the database itself
select ok(
  pg_temp.write_refused($$update public.circle_members set role = 'owner'
    where circle_id = 'a0c00000-0000-4000-8000-000000000001' and user_id = 'aa000002-0000-4000-8000-000000000002'$$),
  'even the server cannot give circle A a second owner');
select ok(
  pg_temp.write_refused($$insert into public.circle_members (circle_id, user_id, role)
    values ('a0c00000-0000-4000-8000-000000000001', 'cc000001-0000-4000-8000-000000000001', 'owner')$$),
  'even the server cannot insert a second owner');

-- rows cannot point at another family's rows (server jobs join on these ids)
select ok(
  pg_temp.write_refused($$insert into public.dose_events (medication_id, circle_id, due_at)
    values ('a0200000-0000-4000-8000-000000000001', 'b0c00000-0000-4000-8000-000000000001', '2026-11-16T08:00:00Z')$$),
  'a dose event in circle B cannot use circle A''s medication');
select ok(
  pg_temp.write_refused($$insert into public.visit_notes (circle_id, appointment_id, transcript, summary)
    values ('b0c00000-0000-4000-8000-000000000001', 'a0400000-0000-4000-8000-000000000001', 't', 's')$$),
  'a visit note in circle B cannot use circle A''s appointment');

-- the owner of family B sees nothing of family A and cannot write to it
select pg_temp.login('bb000001-0000-4000-8000-000000000001');

select is(pg_temp.rows_in('circles', 'a0c00000-0000-4000-8000-000000000001'), 0, 'family B owner reads 0 of A''s circles rows');
select is(pg_temp.rows_in('circle_members', 'a0c00000-0000-4000-8000-000000000001'), 0, 'family B owner reads 0 of A''s circle_members rows');
select is(pg_temp.rows_in('invites', 'a0c00000-0000-4000-8000-000000000001'), 0, 'family B owner reads 0 of A''s invites rows');
select is(pg_temp.rows_in('medications', 'a0c00000-0000-4000-8000-000000000001'), 0, 'family B owner reads 0 of A''s medications rows');
select is(pg_temp.rows_in('dose_events', 'a0c00000-0000-4000-8000-000000000001'), 0, 'family B owner reads 0 of A''s dose_events rows');
select is(pg_temp.rows_in('appointments', 'a0c00000-0000-4000-8000-000000000001'), 0, 'family B owner reads 0 of A''s appointments rows');
select is(pg_temp.rows_in('tasks', 'a0c00000-0000-4000-8000-000000000001'), 0, 'family B owner reads 0 of A''s tasks rows');
select is(pg_temp.rows_in('visit_notes', 'a0c00000-0000-4000-8000-000000000001'), 0, 'family B owner reads 0 of A''s visit_notes rows');
select is(pg_temp.rows_in('log_entries', 'a0c00000-0000-4000-8000-000000000001'), 0, 'family B owner reads 0 of A''s log_entries rows');
select ok(
  pg_temp.rows_in('medications', 'b0c00000-0000-4000-8000-000000000001') = 1
    and pg_temp.rows_in('invites', 'b0c00000-0000-4000-8000-000000000001') = 1
    and pg_temp.rows_in('log_entries', 'b0c00000-0000-4000-8000-000000000001') >= 1,
  'family B owner still reads their own circle (so the zeros above are not a broken login)');

select is(pg_temp.write_count($$insert into public.medications (circle_id, name, dose_text, schedule, source)
    values ('a0c00000-0000-4000-8000-000000000001', 'Planted', '1', '{"kind":"as_needed"}', 'manual')$$),
  -1, 'family B owner cannot add a medication to family A');
select is(pg_temp.write_count($$insert into public.tasks (circle_id, title, source)
    values ('a0c00000-0000-4000-8000-000000000001', 'Planted', 'manual')$$),
  -1, 'family B owner cannot add a task to family A');
select is(pg_temp.write_count($$insert into public.appointments (circle_id, title, starts_at)
    values ('a0c00000-0000-4000-8000-000000000001', 'Planted', now())$$),
  -1, 'family B owner cannot add an appointment to family A');
select is(pg_temp.write_count($$insert into public.visit_notes (circle_id, transcript, summary)
    values ('a0c00000-0000-4000-8000-000000000001', 'Planted', 'Planted')$$),
  -1, 'family B owner cannot add a visit note to family A');
select is(pg_temp.write_count($$insert into public.dose_events (medication_id, circle_id, due_at, status)
    values ('a0200000-0000-4000-8000-000000000001', 'a0c00000-0000-4000-8000-000000000001', '2026-11-17T08:00:00Z', 'given')$$),
  -1, 'family B owner cannot add a dose event to family A');
select is(pg_temp.write_count($$insert into public.invites (circle_id, role)
    values ('a0c00000-0000-4000-8000-000000000001', 'helper')$$),
  -1, 'family B owner cannot create an invite to family A');

-- and cannot change or delete family A's rows
select ok(pg_temp.write_count($$update public.medications set name = 'Hacked' where circle_id = 'a0c00000-0000-4000-8000-000000000001'$$) <= 0,
  'family B owner cannot edit family A''s medications');
select ok(pg_temp.write_count($$update public.dose_events set status = 'given' where circle_id = 'a0c00000-0000-4000-8000-000000000001'$$) <= 0,
  'family B owner cannot mark family A''s doses');
select ok(pg_temp.write_count($$delete from public.appointments where circle_id = 'a0c00000-0000-4000-8000-000000000001'$$) <= 0,
  'family B owner cannot delete family A''s appointments');
select ok(pg_temp.write_count($$delete from public.circle_members where circle_id = 'a0c00000-0000-4000-8000-000000000001'$$) <= 0,
  'family B owner cannot remove family A''s members');
select ok(pg_temp.write_count($$delete from public.circles where id = 'a0c00000-0000-4000-8000-000000000001'$$) <= 0,
  'family B owner cannot delete family A''s circle');

-- a user in no circle cannot join one without an invite
select pg_temp.login('cc000001-0000-4000-8000-000000000001');
select ok(
  pg_temp.write_refused($$insert into public.circle_members (circle_id, user_id, role)
    values ('a0c00000-0000-4000-8000-000000000001', 'cc000001-0000-4000-8000-000000000001', 'viewer')$$),
  'a user cannot add themselves to a circle (only an invite, through accept_invite, does that)');
select ok(
  pg_temp.write_refused($$update public.invites set used_by = 'cc000001-0000-4000-8000-000000000001'
    where circle_id = 'a0c00000-0000-4000-8000-000000000001'$$),
  'a user cannot mark an invite as used directly');

-- helper of family A
select pg_temp.login('aa000002-0000-4000-8000-000000000002');

select is(pg_temp.rows_everywhere('b0c00000-0000-4000-8000-000000000001'), 0,
  'family A helper reads 0 rows of family B in all 9 tables');
select is(pg_temp.rows_in('invites', 'a0c00000-0000-4000-8000-000000000001'), 0,
  'helper cannot read invite links (a readable token would let a helper invite people)');

select ok(
  pg_temp.write_refused($$update public.circle_members set role = 'owner'
    where circle_id = 'a0c00000-0000-4000-8000-000000000001' and user_id = 'aa000002-0000-4000-8000-000000000002'$$),
  'helper cannot make themselves owner');
select ok(
  pg_temp.write_refused($$update public.circle_members set role = 'viewer'
    where circle_id = 'a0c00000-0000-4000-8000-000000000001' and user_id = 'aa000001-0000-4000-8000-000000000001'$$),
  'helper cannot demote the owner');
select ok(
  pg_temp.write_refused($$update public.circles set name = 'Renamed', timezone = 'UTC'
    where id = 'a0c00000-0000-4000-8000-000000000001'$$),
  'helper cannot change the circle''s name or time zone (circle settings are owner only)');
select ok(
  pg_temp.write_refused($$delete from public.invites where circle_id = 'a0c00000-0000-4000-8000-000000000001'$$),
  'helper cannot delete invites');
select ok(
  pg_temp.write_refused($$update public.tasks set circle_id = 'b0c00000-0000-4000-8000-000000000001'
    where id = 'a0500000-0000-4000-8000-000000000001'$$),
  'helper cannot move a task into another family''s circle');
select ok(
  pg_temp.write_refused($$update public.medications set circle_id = 'b0c00000-0000-4000-8000-000000000001'
    where id = 'a0200000-0000-4000-8000-000000000001'$$),
  'helper cannot move a medication into another family''s circle');

-- The roles table: a helper adds and edits meds, appointments, tasks and notes, and marks doses.
select is(pg_temp.write_count($$insert into public.medications (circle_id, name, dose_text, schedule, source)
    values ('a0c00000-0000-4000-8000-000000000001', 'Helper med', '1 tablet', '{"kind":"weekly","days":["mon"],"times":["09:00"]}', 'manual')$$),
  1, 'helper can add a medication');
select is(pg_temp.write_count($$update public.medications set dose_text = '2 tablets'
    where id = 'a0200000-0000-4000-8000-000000000001'$$),
  1, 'helper can edit a medication');
select is(pg_temp.write_count($$insert into public.appointments (circle_id, title, starts_at)
    values ('a0c00000-0000-4000-8000-000000000001', 'Helper appt', '2026-11-25T09:00:00Z')$$),
  1, 'helper can add an appointment');
select is(pg_temp.write_count($$insert into public.tasks (circle_id, title, source)
    values ('a0c00000-0000-4000-8000-000000000001', 'Helper task', 'manual')$$),
  1, 'helper can add a task');
select is(pg_temp.write_count($$update public.tasks set done_at = now(), done_by = 'aa000002-0000-4000-8000-000000000002'
    where id = 'a0500000-0000-4000-8000-000000000001'$$),
  1, 'helper can complete a task');
select is(pg_temp.write_count($$insert into public.visit_notes (circle_id, appointment_id, transcript, summary)
    values ('a0c00000-0000-4000-8000-000000000001', 'a0400000-0000-4000-8000-000000000001', 'Helper transcript', 'Helper note')$$),
  1, 'helper can add a visit note');
select is(pg_temp.write_count($$update public.dose_events set status = 'given', acted_by = 'aa000002-0000-4000-8000-000000000002', acted_at = now()
    where id = 'a0300000-0000-4000-8000-000000000001'$$),
  1, 'helper can mark a dose given');

select ok(
  exists (select 1 from public.log_entries
          where circle_id = 'a0c00000-0000-4000-8000-000000000001' and type = 'dose'
            and ref_id = 'a0300000-0000-4000-8000-000000000001'
            and created_by = 'aa000002-0000-4000-8000-000000000002'),
  'marking the dose wrote a dose log entry pointing at that dose, made by the helper');
select ok(
  exists (select 1 from public.log_entries
          where circle_id = 'a0c00000-0000-4000-8000-000000000001' and type = 'task'
            and ref_id = 'a0500000-0000-4000-8000-000000000001'
            and created_by = 'aa000002-0000-4000-8000-000000000002'),
  'completing the task wrote a task log entry pointing at that task, made by the helper');
select ok(
  exists (select 1 from public.log_entries
          where circle_id = 'a0c00000-0000-4000-8000-000000000001' and type = 'med_change'
            and ref_id = 'a0200000-0000-4000-8000-000000000001'
            and created_by = 'aa000002-0000-4000-8000-000000000002'),
  'editing the medication wrote a med_change log entry pointing at it, made by the helper');

select pg_temp.write_refused($$insert into public.visit_notes (circle_id, transcript, summary, created_by)
    values ('a0c00000-0000-4000-8000-000000000001', 'Spoof', 'Spoof note', 'aa000001-0000-4000-8000-000000000001')$$);
select pg_temp.write_refused($$update public.visit_notes set created_by = 'aa000001-0000-4000-8000-000000000001'
    where summary = 'Helper note'$$);
select pg_temp.login(null);
select is(
  (select count(*)::int from public.visit_notes
    where circle_id = 'a0c00000-0000-4000-8000-000000000001'
      and summary in ('Spoof note', 'Helper note') and created_by = 'aa000001-0000-4000-8000-000000000001'),
  0, 'helper cannot write a visit note in the owner''s name');
select is(
  (select created_by from public.visit_notes where summary = 'Helper note'),
  'aa000002-0000-4000-8000-000000000002'::uuid,
  'a visit note records the signed-in author');
select is(
  (select role::text from public.circle_members
    where circle_id = 'a0c00000-0000-4000-8000-000000000001' and user_id = 'aa000002-0000-4000-8000-000000000002'),
  'helper', 'helper is still a helper after the attempts above');
select is(
  (select name from public.circles where id = 'a0c00000-0000-4000-8000-000000000001'),
  'Family A', 'circle A was not renamed by the helper');

-- viewer of family A
select pg_temp.login('aa000003-0000-4000-8000-000000000003');
select is(pg_temp.rows_everywhere('b0c00000-0000-4000-8000-000000000001'), 0,
  'family A viewer reads 0 rows of family B in all 9 tables');
select ok(
  pg_temp.write_refused($$delete from public.circle_members
    where circle_id = 'a0c00000-0000-4000-8000-000000000001' and user_id = 'aa000001-0000-4000-8000-000000000001'$$),
  'viewer cannot remove the owner');

-- owner of family A
select pg_temp.login('aa000001-0000-4000-8000-000000000001');

select is(pg_temp.rows_everywhere('b0c00000-0000-4000-8000-000000000001'), 0,
  'family A owner reads 0 rows of family B in all 9 tables');
select is(pg_temp.rows_in('invites', 'a0c00000-0000-4000-8000-000000000001'), 1, 'owner reads the circle''s invites');

select is(pg_temp.write_count($$insert into public.invites (circle_id) values ('a0c00000-0000-4000-8000-000000000001')$$),
  1, 'owner can create an invite with only the circle id');
select pg_temp.write_count($$insert into public.invites (circle_id) values ('a0c00000-0000-4000-8000-000000000001')$$);
select ok(
  (select count(distinct token) = 3 and bool_and(char_length(token) >= 32) from public.invites
    where circle_id = 'a0c00000-0000-4000-8000-000000000001'),
  'the database makes a different, long (at least 32 characters) token for each invite');
select ok(
  (select bool_and(role = 'helper' and used_by is null
                   and expires_at between now() + interval '7 days' - interval '1 minute'
                                      and now() + interval '7 days' + interval '1 minute')
     from public.invites
    where circle_id = 'a0c00000-0000-4000-8000-000000000001'
      and id <> 'a0100000-0000-4000-8000-000000000001'),
  'a new invite defaults to role helper, unused, valid for 7 days');
select ok(
  pg_temp.write_refused($$insert into public.invites (circle_id, token) values
    ('a0c00000-0000-4000-8000-000000000001', 'guessable')$$),
  'the app cannot choose its own (guessable) invite token');
select ok(
  pg_temp.write_refused($$insert into public.invites (circle_id, role) values ('a0c00000-0000-4000-8000-000000000001', 'owner')$$),
  'an invite cannot make someone owner (a circle has exactly one owner)');
select ok(
  pg_temp.write_refused($$update public.invites set used_by = null, expires_at = now() + interval '1 year'
    where id = 'a0100000-0000-4000-8000-000000000001'$$),
  'owner cannot reset or extend an invite (single use, 7 days; make a new one)');
select is(
  pg_temp.write_count($$delete from public.invites where id = 'a0100000-0000-4000-8000-000000000001'$$),
  1, 'owner can cancel an invite');
select ok(
  pg_temp.write_refused($$insert into public.circle_members (circle_id, user_id, role)
    values ('a0c00000-0000-4000-8000-000000000001', 'cc000001-0000-4000-8000-000000000001', 'helper')$$),
  'owner cannot add a member directly (only accept_invite, which also checks the plan limit)');
select ok(
  pg_temp.write_refused($$update public.circle_members set role = 'owner'
    where circle_id = 'a0c00000-0000-4000-8000-000000000001' and user_id = 'aa000003-0000-4000-8000-000000000003'$$),
  'owner cannot make a second owner (transfer is its own server function, later)');
select ok(
  pg_temp.write_refused($$update public.circle_members set role = 'helper'
    where circle_id = 'a0c00000-0000-4000-8000-000000000001' and user_id = 'aa000001-0000-4000-8000-000000000001'$$),
  'owner cannot demote themselves and leave the circle with no owner');
select ok(
  pg_temp.write_refused($$delete from public.circle_members
    where circle_id = 'a0c00000-0000-4000-8000-000000000001' and user_id = 'aa000001-0000-4000-8000-000000000001'$$),
  'the last owner cannot leave the circle');
select is(
  pg_temp.write_count($$update public.circle_members set role = 'helper'
    where circle_id = 'a0c00000-0000-4000-8000-000000000001' and user_id = 'aa000003-0000-4000-8000-000000000003'$$),
  1, 'owner can change a viewer to helper');
select is(
  pg_temp.write_count($$update public.circles set name = 'Family A renamed' where id = 'a0c00000-0000-4000-8000-000000000001'$$),
  1, 'owner can rename the circle');
select is(
  pg_temp.write_count($$delete from public.circle_members
    where circle_id = 'a0c00000-0000-4000-8000-000000000001' and user_id = 'aa000002-0000-4000-8000-000000000002'$$),
  1, 'owner can remove the helper');
select ok(
  exists (select 1 from public.log_entries
          where circle_id = 'a0c00000-0000-4000-8000-000000000001' and type = 'member'
            and ref_id = 'aa000002-0000-4000-8000-000000000002'
            and created_by = 'aa000001-0000-4000-8000-000000000001'),
  'removing the helper wrote a member log entry pointing at that person, made by the owner');

-- a removed member loses access at once
select pg_temp.login('aa000002-0000-4000-8000-000000000002');
select is(pg_temp.rows_everywhere('a0c00000-0000-4000-8000-000000000001'), 0,
  'the removed helper now reads 0 rows of family A in all 9 tables');
select ok(
  pg_temp.write_count($$update public.tasks set title = 'After removal' where circle_id = 'a0c00000-0000-4000-8000-000000000001'$$) <= 0,
  'the removed helper can no longer edit family A''s tasks');

-- anon writes nothing
select pg_temp.login(null);
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is(pg_temp.write_count($$insert into public.medications (circle_id, name, dose_text, schedule, source)
    values ('a0c00000-0000-4000-8000-000000000001', 'Anon', '1', '{"kind":"as_needed"}', 'manual')$$),
  -1, 'a signed-out request cannot add a medication');
select ok(pg_temp.write_count($$delete from public.tasks$$) <= 0, 'a signed-out request cannot delete tasks');
select is(pg_temp.rows_everywhere('a0c00000-0000-4000-8000-000000000001'), 0,
  'a signed-out request reads 0 rows of family A in all 9 tables');

-- the owner deletes the circle, and every row of it goes, log included; family B is untouched
select pg_temp.login('aa000001-0000-4000-8000-000000000001');
select is(pg_temp.write_count($$delete from public.circles where id = 'a0c00000-0000-4000-8000-000000000001'$$),
  1, 'owner can delete the circle');
select pg_temp.login(null);
select is(pg_temp.rows_in('circle_members', 'a0c00000-0000-4000-8000-000000000001'), 0, 'deleting the circle removed its members');
select is(pg_temp.rows_in('invites', 'a0c00000-0000-4000-8000-000000000001'), 0, 'deleting the circle removed its invites');
select is(pg_temp.rows_in('medications', 'a0c00000-0000-4000-8000-000000000001'), 0, 'deleting the circle removed its medications');
select is(pg_temp.rows_in('dose_events', 'a0c00000-0000-4000-8000-000000000001'), 0, 'deleting the circle removed its dose events');
select is(
  pg_temp.rows_in('appointments', 'a0c00000-0000-4000-8000-000000000001')
    + pg_temp.rows_in('tasks', 'a0c00000-0000-4000-8000-000000000001')
    + pg_temp.rows_in('visit_notes', 'a0c00000-0000-4000-8000-000000000001'),
  0, 'deleting the circle removed its appointments, tasks and visit notes');
select is(pg_temp.rows_in('log_entries', 'a0c00000-0000-4000-8000-000000000001'), 0, 'deleting the circle removed its care log');
select ok(pg_temp.rows_everywhere('b0c00000-0000-4000-8000-000000000001') >= 9, 'family B''s rows are all still there');
select ok(
  exists (select 1 from public.log_entries where circle_id = 'b0c00000-0000-4000-8000-000000000001' and type = 'member'),
  'family B''s care log is still there');

select * from finish();

rollback;
