-- CC-0 review (PR #23): rules the first two C1 files do not reach.
-- 1. Someone who belongs to two families cannot move a row from one family into the other.
-- 2. People named on a row (who gave a dose, who drives, who a task is for) are members of that circle,
--    and a signed-in user records an action only as themselves, so the care log names the right person.
-- 3. Columns the database owns (ids, created_by, created_at) are not rewritten from the app.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(26);

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

-- Rows a write changed; -1 when refused for any reason (privilege, RLS, check, trigger).
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
  when others then
    return -1;
end;
$$;

-- Users: A's owner, a person who is a helper in A and the owner of B, B's owner-to-be helper, and a stranger.
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select u.id, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', u.email,
       '{}'::jsonb, '{}'::jsonb, now(), now()
from (values
  ('da000001-0000-4000-8000-000000000001'::uuid, 'a-owner@example.test'),
  ('da000002-0000-4000-8000-000000000002'::uuid, 'two-families@example.test'),
  ('da000003-0000-4000-8000-000000000003'::uuid, 'a-helper-who-leaves@example.test'),
  ('db000001-0000-4000-8000-000000000001'::uuid, 'b-helper@example.test')
) as u(id, email);

insert into public.circles (id, name, care_recipient_name, timezone) values
  ('dac00000-0000-4000-8000-000000000001', 'Family A', 'Grandma A', 'Europe/Paris'),
  ('dbc00000-0000-4000-8000-000000000001', 'Family B', 'Grandpa B', 'Europe/Paris');

insert into public.circle_members (circle_id, user_id, role) values
  ('dac00000-0000-4000-8000-000000000001', 'da000001-0000-4000-8000-000000000001', 'owner'),
  ('dac00000-0000-4000-8000-000000000001', 'da000002-0000-4000-8000-000000000002', 'helper'),
  ('dac00000-0000-4000-8000-000000000001', 'da000003-0000-4000-8000-000000000003', 'helper'),
  ('dbc00000-0000-4000-8000-000000000001', 'da000002-0000-4000-8000-000000000002', 'owner'),
  ('dbc00000-0000-4000-8000-000000000001', 'db000001-0000-4000-8000-000000000001', 'helper');

insert into public.medications (id, circle_id, name, dose_text, schedule, source) values
  ('da200000-0000-4000-8000-000000000001', 'dac00000-0000-4000-8000-000000000001', 'Med A', '1 tablet',
   '{"kind":"daily","times":["08:00"]}', 'manual');
insert into public.dose_events (id, medication_id, circle_id, due_at) values
  ('da300000-0000-4000-8000-000000000001', 'da200000-0000-4000-8000-000000000001',
   'dac00000-0000-4000-8000-000000000001', '2026-11-15T07:00:00Z');
insert into public.appointments (id, circle_id, title, starts_at) values
  ('da400000-0000-4000-8000-000000000001', 'dac00000-0000-4000-8000-000000000001', 'Appt A', '2026-11-20T09:00:00Z');
insert into public.tasks (id, circle_id, title, assignee, source) values
  ('da500000-0000-4000-8000-000000000001', 'dac00000-0000-4000-8000-000000000001', 'Task A',
   'da000003-0000-4000-8000-000000000003', 'manual');

-- 1. No moving rows between families, even for someone allowed to write in both.
select pg_temp.login('da000002-0000-4000-8000-000000000002');
select is(pg_temp.write_count($$update public.medications set circle_id = 'dbc00000-0000-4000-8000-000000000001'
  where id = 'da200000-0000-4000-8000-000000000001'$$), -1, 'a helper in A who owns B cannot move A''s medicine into B');
select is(pg_temp.write_count($$update public.appointments set circle_id = 'dbc00000-0000-4000-8000-000000000001'
  where id = 'da400000-0000-4000-8000-000000000001'$$), -1, '... nor A''s appointment');
select is(pg_temp.write_count($$update public.tasks set circle_id = 'dbc00000-0000-4000-8000-000000000001'
  where id = 'da500000-0000-4000-8000-000000000001'$$), -1, '... nor A''s task');
select is(pg_temp.write_count($$update public.dose_events set circle_id = 'dbc00000-0000-4000-8000-000000000001'
  where id = 'da300000-0000-4000-8000-000000000001'$$), -1, '... nor A''s dose');
select is(pg_temp.write_count($$update public.visit_notes set circle_id = 'dbc00000-0000-4000-8000-000000000001'$$), -1,
  '... nor a visit note');
select pg_temp.login(null);
select is((select count(*)::int from public.medications where circle_id = 'dbc00000-0000-4000-8000-000000000001')
  + (select count(*)::int from public.appointments where circle_id = 'dbc00000-0000-4000-8000-000000000001')
  + (select count(*)::int from public.tasks where circle_id = 'dbc00000-0000-4000-8000-000000000001'), 0,
  'family B holds none of family A''s rows afterwards');

-- 1b. Normal edits by a helper still work.
select pg_temp.login('da000002-0000-4000-8000-000000000002');
select is(pg_temp.write_count($$update public.medications set dose_text = '2 tablets'
  where id = 'da200000-0000-4000-8000-000000000001'$$), 1, 'a helper can still edit a medicine');
select is(pg_temp.write_count($$update public.appointments set title = 'Appt A moved', starts_at = '2026-11-21T09:00:00Z'
  where id = 'da400000-0000-4000-8000-000000000001'$$), 1, 'a helper can still edit an appointment');

-- 2. People named on a row are members of that circle.
select is(pg_temp.write_count($$update public.tasks set assignee = 'db000001-0000-4000-8000-000000000001'
  where id = 'da500000-0000-4000-8000-000000000001'$$), -1, 'a task cannot be assigned to someone outside the circle');
select is(pg_temp.write_count($$update public.appointments set driver_user_id = 'db000001-0000-4000-8000-000000000001'
  where id = 'da400000-0000-4000-8000-000000000001'$$), -1, 'a driver must be in the circle');
select is(pg_temp.write_count($$insert into public.tasks (circle_id, title, assignee, source)
  values ('dac00000-0000-4000-8000-000000000001', 'x', 'db000001-0000-4000-8000-000000000001', 'manual')$$), -1,
  'a new task cannot name someone outside the circle');
select is(pg_temp.write_count($$update public.appointments set driver_user_id = 'da000001-0000-4000-8000-000000000001'
  where id = 'da400000-0000-4000-8000-000000000001'$$), 1, 'a member of the circle can be the driver');

-- 2b. A signed-in user records a dose or a task only as themselves.
select is(pg_temp.write_count($$update public.dose_events set status = 'given', acted_by = 'da000001-0000-4000-8000-000000000001', acted_at = now()
  where id = 'da300000-0000-4000-8000-000000000001'$$), -1, 'a helper cannot mark a dose given in the owner''s name');
select is(pg_temp.write_count($$update public.tasks set done_at = now(), done_by = 'da000001-0000-4000-8000-000000000001'
  where id = 'da500000-0000-4000-8000-000000000001'$$), -1, 'a helper cannot complete a task in the owner''s name');
-- CC-2b: doses are marked only through set_dose_status, which always records the caller.
select is(pg_temp.write_count($$select public.set_dose_status("doseEventId" := 'da300000-0000-4000-8000-000000000001', status := 'given')$$),
  1, 'a helper marks a dose given as themselves (through set_dose_status)');
select pg_temp.login(null);
select is((select created_by from public.log_entries
            where circle_id = 'dac00000-0000-4000-8000-000000000001' and type = 'dose'
              and ref_id = 'da300000-0000-4000-8000-000000000001'),
  'da000002-0000-4000-8000-000000000002'::uuid, 'the care log names the person who marked the dose');

-- 2c. Someone leaves; tasks still assigned to them can still be edited and completed.
delete from public.circle_members
 where circle_id = 'dac00000-0000-4000-8000-000000000001' and user_id = 'da000003-0000-4000-8000-000000000003';
select pg_temp.login('da000002-0000-4000-8000-000000000002');
select is(pg_temp.write_count($$update public.tasks set title = 'Task A renamed', done_at = now(),
  done_by = 'da000002-0000-4000-8000-000000000002' where id = 'da500000-0000-4000-8000-000000000001'$$), 1,
  'a task assigned to someone who left can still be edited and completed');

-- 2d. The server (no signed-in user) can still mark a dose missed with nobody named.
select pg_temp.login(null);
insert into public.dose_events (id, medication_id, circle_id, due_at) values
  ('da300000-0000-4000-8000-000000000002', 'da200000-0000-4000-8000-000000000001',
   'dac00000-0000-4000-8000-000000000001', '2026-11-16T07:00:00Z');
select is(pg_temp.write_count($$update public.dose_events set status = 'missed'
  where id = 'da300000-0000-4000-8000-000000000002'$$), 1, 'the server can mark a dose missed');

-- 3. Columns the database owns.
select pg_temp.login('da000001-0000-4000-8000-000000000001');
select is(pg_temp.write_count($$update public.circles set created_at = '2000-01-01T00:00:00Z'
  where id = 'dac00000-0000-4000-8000-000000000001'$$), -1, 'the owner cannot rewrite when the circle was created');
select is(pg_temp.write_count($$update public.circles set created_by = 'da000002-0000-4000-8000-000000000002'
  where id = 'dac00000-0000-4000-8000-000000000001'$$), -1, '... nor who created it');
select is(pg_temp.write_count($$update public.circles set name = 'Family A renamed'
  where id = 'dac00000-0000-4000-8000-000000000001'$$), 1, 'the owner can still rename the circle');
select is(pg_temp.write_count($$insert into public.visit_notes (circle_id, summary, created_at)
  values ('dac00000-0000-4000-8000-000000000001', 'Backdated', '2001-01-01T00:00:00Z')$$), -1,
  'a visit note cannot be backdated');

-- 4. Account deletion (CC-10): a member's account can be deleted; the family keeps its care log.
-- da000003 joined family A (the join line names them) and left it earlier in this file.
select pg_temp.login(null);
create temp table member_lines as
  select id from public.log_entries
   where circle_id = 'dac00000-0000-4000-8000-000000000001'
     and created_by = 'da000003-0000-4000-8000-000000000003';
select ok((select count(*) from member_lines) > 0, 'the care log names the member before they delete their account');
select lives_ok($$delete from auth.users where id = 'da000003-0000-4000-8000-000000000003'$$,
  'a member can delete their account although the care log names them');
select is((select count(*)::int from public.log_entries l join member_lines m using (id) where l.created_by is null),
  (select count(*)::int from member_lines),
  'their care log lines stay, with nobody named');
select throws_ok($$delete from auth.users where id = 'da000001-0000-4000-8000-000000000001'$$, '42501', null,
  'an owner cannot delete their account while the circle exists (transfer or delete it first)');

select * from finish();
rollback;
