-- CC-10 [safety 1/2]: pgTAP tests for account deletion, solo-owner circle deletion,
-- `public.transfer_ownership("circleId" uuid, "newOwnerId" uuid)`, and `public.export_user_data()`.
--
-- Proposed functions to be added in CC-10 [safety 2/2]:
-- 1. `public.transfer_ownership("circleId" uuid, "newOwnerId" uuid) returns jsonb`
--    (`SECURITY DEFINER`, `set search_path = ''`, `authenticated` only)
-- 2. `public.export_user_data() returns jsonb`
--    (`SECURITY DEFINER`, `set search_path = ''`, `authenticated` only)
-- 3. `public.delete_own_account() returns jsonb` (or service-role helper invoked by
--    `POST /functions/v1/delete-account` before `auth.admin.deleteUser(userId)`).
--
-- User-column disposition on account deletion:
-- - `users_profile.user_id`        -> DELETED (`ON DELETE CASCADE`)
-- - `circle_members.user_id`       -> DELETED (`ON DELETE CASCADE`, or circle deleted for solo owner)
-- - `push_tokens.user_id`          -> DELETED (`ON DELETE CASCADE`)
-- - `entitlements.user_id`         -> DELETED (`ON DELETE CASCADE`)
-- - `ai_calls.user_id`             -> DELETED (`ON DELETE CASCADE`)
-- - `invites.used_by`              -> SET TO NULL (`ON DELETE SET NULL`; `expires_at <= now()` keeps invite used)
-- - `circles.created_by`           -> SET TO NULL (`ON DELETE SET NULL` in surviving circles; DELETED for solo owner)
-- - `dose_events.acted_by`         -> SET TO NULL (`ON DELETE SET NULL` in surviving circles; DELETED for solo owner)
-- - `appointments.driver_user_id`  -> SET TO NULL (`ON DELETE SET NULL` in surviving circles; DELETED for solo owner)
-- - `tasks.assignee`               -> SET TO NULL (`ON DELETE SET NULL` in surviving circles; DELETED for solo owner)
-- - `tasks.done_by`                -> SET TO NULL (`ON DELETE SET NULL` in surviving circles; DELETED for solo owner)
-- - `visit_notes.created_by`       -> SET TO NULL (`ON DELETE SET NULL` in surviving circles; DELETED for solo owner)
-- - `log_entries.created_by`       -> SET TO NULL (`ON DELETE SET NULL` in surviving circles; DELETED for solo owner)
-- - `log_entries.ref_id` (member)  -> SET TO NULL when `ref_id = deleted_user_id` in surviving circles

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(27);

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

-- Seed users:
-- u01: Owner of Multi-Member Circle M (with u02 as helper, u03 as viewer)
-- u02: Helper in Circle M (receives ownership transfer from u01)
-- u03: Viewer in Circle M (deletes account as non-owner)
-- u04: Solo Owner of Circle S (only member; deleting account deletes entire Circle S)
-- u05: Stranger in Circle X (must never appear in u02/u03 data export)
select pg_temp.as_postgres();

insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('cc100000-0000-4000-8000-000000000001'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'cc10-u01@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('cc100000-0000-4000-8000-000000000002'::uuid, '00000000-0000-4000-8000-000000000000'::uuid, 'authenticated', 'authenticated', 'cc10-u02@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('cc100000-0000-4000-8000-000000000003'::uuid, '00000000-0000-4000-8000-000000000000'::uuid, 'authenticated', 'authenticated', 'cc10-u03@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('cc100000-0000-4000-8000-000000000004'::uuid, '00000000-0000-4000-8000-000000000000'::uuid, 'authenticated', 'authenticated', 'cc10-u04@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('cc100000-0000-4000-8000-000000000005'::uuid, '00000000-0000-4000-8000-000000000000'::uuid, 'authenticated', 'authenticated', 'cc10-u05@example.test', '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.users_profile (user_id, display_name, locale, timezone)
values
  ('cc100000-0000-4000-8000-000000000001'::uuid, 'Owner One', 'en', 'America/New_York'),
  ('cc100000-0000-4000-8000-000000000002'::uuid, 'Helper Two', 'en', 'America/New_York'),
  ('cc100000-0000-4000-8000-000000000003'::uuid, 'Viewer Three', 'en', 'America/New_York'),
  ('cc100000-0000-4000-8000-000000000004'::uuid, 'Solo Owner Four', 'en', 'America/New_York'),
  ('cc100000-0000-4000-8000-000000000005'::uuid, 'Stranger Five', 'en', 'Europe/Paris');

-- Give u01 Family entitlement so Circle M can have 3 members
insert into public.entitlements (user_id, entitlement, active, expires_at)
values
  ('cc100000-0000-4000-8000-000000000001'::uuid, 'carecircle_family', true, now() + interval '30 days'),
  ('cc100000-0000-4000-8000-000000000003'::uuid, 'carecircle_family', false, null),
  ('cc100000-0000-4000-8000-000000000005'::uuid, 'carecircle_family', true, now() + interval '30 days');

insert into public.push_tokens (user_id, token, platform)
values
  ('cc100000-0000-4000-8000-000000000003'::uuid, 'ExponentPushToken[cc10-u03]', 'ios'),
  ('cc100000-0000-4000-8000-000000000004'::uuid, 'ExponentPushToken[cc10-u04]', 'android'),
  ('cc100000-0000-4000-8000-000000000005'::uuid, 'ExponentPushToken[cc10-u05]', 'ios');

insert into public.ai_calls (request_id, user_id, task, model, prompt_version, latency_ms, input_tokens, output_tokens, estimated_cost_microcents, cost_currency, validation_ok)
values
  ('cc10a000-0000-4000-8000-000000000003'::uuid, 'cc100000-0000-4000-8000-000000000003'::uuid, 'carecircle.extractPrescription', 'gemini/gemini-3.5-flash-lite', '1.0.0', 500, 100, 50, 15000, 'USD', true),
  ('cc10a000-0000-4000-8000-000000000004'::uuid, 'cc100000-0000-4000-8000-000000000004'::uuid, 'carecircle.extractPrescription', 'gemini/gemini-3.5-flash-lite', '1.0.0', 500, 100, 50, 15000, 'USD', true);

-- Seed Circle M (multi-member), Circle S (solo owner u04), Circle X (stranger u05)
insert into public.circles (id, name, care_recipient_name, timezone, created_by)
values
  ('cc10c001-0000-4000-8000-000000000001'::uuid, 'Circle M', 'Recipient M', 'America/New_York', 'cc100000-0000-4000-8000-000000000001'::uuid),
  ('cc10c004-0000-4000-8000-000000000004'::uuid, 'Circle S', 'Recipient S', 'America/New_York', 'cc100000-0000-4000-8000-000000000004'::uuid),
  ('cc10c005-0000-4000-8000-000000000005'::uuid, 'Circle X', 'Secret Recipient X', 'Europe/Paris', 'cc100000-0000-4000-8000-000000000005'::uuid);

insert into public.circle_members (circle_id, user_id, role)
values
  ('cc10c001-0000-4000-8000-000000000001'::uuid, 'cc100000-0000-4000-8000-000000000001'::uuid, 'owner'),
  ('cc10c001-0000-4000-8000-000000000001'::uuid, 'cc100000-0000-4000-8000-000000000002'::uuid, 'helper'),
  ('cc10c001-0000-4000-8000-000000000001'::uuid, 'cc100000-0000-4000-8000-000000000003'::uuid, 'viewer'),
  ('cc10c004-0000-4000-8000-000000000004'::uuid, 'cc100000-0000-4000-8000-000000000004'::uuid, 'owner'),
  ('cc10c005-0000-4000-8000-000000000005'::uuid, 'cc100000-0000-4000-8000-000000000005'::uuid, 'owner');

-- Seed domain rows in Circle M referencing u02 and u03 across every user column
insert into public.invites (id, circle_id, token, role, expires_at, used_by)
values (
  'cc101001-0000-4000-8000-000000000001'::uuid,
  'cc10c001-0000-4000-8000-000000000001'::uuid,
  'cc10_invite_token_used_by_u03_000000000000000000000003',
  'viewer',
  now() - interval '1 minute',
  'cc100000-0000-4000-8000-000000000003'::uuid
);

insert into public.medications (id, circle_id, name, dose_text, schedule, source)
values
  ('cc102001-0000-4000-8000-000000000001'::uuid, 'cc10c001-0000-4000-8000-000000000001'::uuid, 'Med M', '1 tablet', '{"kind":"daily","times":["08:00"]}'::jsonb, 'manual'),
  ('cc102004-0000-4000-8000-000000000004'::uuid, 'cc10c004-0000-4000-8000-000000000004'::uuid, 'Med S', '1 tablet', '{"kind":"daily","times":["08:00"]}'::jsonb, 'manual');

insert into public.dose_events (id, medication_id, circle_id, due_at, status, acted_by, acted_at)
values
  ('cc103001-0000-4000-8000-000000000001'::uuid, 'cc102001-0000-4000-8000-000000000001'::uuid, 'cc10c001-0000-4000-8000-000000000001'::uuid, now() - interval '2 hours', 'given', 'cc100000-0000-4000-8000-000000000003'::uuid, now() - interval '1 hour'),
  ('cc103004-0000-4000-8000-000000000004'::uuid, 'cc102004-0000-4000-8000-000000000004'::uuid, 'cc10c004-0000-4000-8000-000000000004'::uuid, now() - interval '2 hours', 'given', 'cc100000-0000-4000-8000-000000000004'::uuid, now() - interval '1 hour');

insert into public.appointments (id, circle_id, title, starts_at, driver_user_id)
values
  ('cc104001-0000-4000-8000-000000000001'::uuid, 'cc10c001-0000-4000-8000-000000000001'::uuid, 'Appt M', now() + interval '1 day', 'cc100000-0000-4000-8000-000000000003'::uuid),
  ('cc104004-0000-4000-8000-000000000004'::uuid, 'cc10c004-0000-4000-8000-000000000004'::uuid, 'Appt S', now() + interval '1 day', 'cc100000-0000-4000-8000-000000000004'::uuid);

insert into public.tasks (id, circle_id, title, assignee, done_at, done_by, source)
values
  ('cc105001-0000-4000-8000-000000000001'::uuid, 'cc10c001-0000-4000-8000-000000000001'::uuid, 'Task M', 'cc100000-0000-4000-8000-000000000003'::uuid, now(), 'cc100000-0000-4000-8000-000000000003'::uuid, 'manual'),
  ('cc105004-0000-4000-8000-000000000004'::uuid, 'cc10c004-0000-4000-8000-000000000004'::uuid, 'Task S', 'cc100000-0000-4000-8000-000000000004'::uuid, now(), 'cc100000-0000-4000-8000-000000000004'::uuid, 'manual');

insert into public.visit_notes (id, circle_id, summary, created_by)
values
  ('cc106001-0000-4000-8000-000000000001'::uuid, 'cc10c001-0000-4000-8000-000000000001'::uuid, 'Visit M', 'cc100000-0000-4000-8000-000000000003'::uuid),
  ('cc106004-0000-4000-8000-000000000004'::uuid, 'cc10c004-0000-4000-8000-000000000004'::uuid, 'Visit S', 'cc100000-0000-4000-8000-000000000004'::uuid);

-- ============================================================================
-- Section 1: Data export (`public.export_user_data()`)
-- ============================================================================

select has_function(
  'public',
  'export_user_data',
  array[]::text[],
  'public.export_user_data() exists'
);

select pg_temp.as_user('cc100000-0000-4000-8000-000000000002'::uuid);

select ok(
  (select (public.export_user_data()->>'userId') = 'cc100000-0000-4000-8000-000000000002'),
  'export_user_data() returns the signed-in user''s own userId'
);

select ok(
  (select public.export_user_data()::text like '%Helper Two%'),
  'export_user_data() contains the user''s own users_profile row'
);

select ok(
  (select public.export_user_data()::text like '%cc10c001-0000-4000-8000-000000000001%'),
  'export_user_data() contains memberships for circles the user belongs to'
);

select ok(
  (select public.export_user_data()::text not like '%cc10c005-0000-4000-8000-000000000005%'
      and public.export_user_data()::text not like '%Secret Recipient X%'
      and public.export_user_data()::text not like '%Stranger Five%'),
  'export_user_data() contains nothing from circles the user is not in'
);

select ok(
  (select public.export_user_data()::text not like '%ExponentPushToken[cc10-u03]%'
      and public.export_user_data()::text not like '%cc10a000-0000-4000-8000-000000000003%'),
  'export_user_data() contains nothing of other users'' private push_tokens or ai_calls'
);

-- ============================================================================
-- Section 2: Ownership transfer (`public.transfer_ownership("circleId", "newOwnerId")`)
-- ============================================================================

select has_function(
  'public',
  'transfer_ownership',
  array['uuid', 'uuid'],
  'public.transfer_ownership(circleId uuid, newOwnerId uuid) exists'
);

-- Helper (u02) calling transfer_ownership is refused
select pg_temp.as_user('cc100000-0000-4000-8000-000000000002'::uuid);
select throws_ok(
  $$select public.transfer_ownership(
      "circleId" => 'cc10c001-0000-4000-8000-000000000001'::uuid,
      "newOwnerId" => 'cc100000-0000-4000-8000-000000000002'::uuid
    )$$,
  '42501',
  null,
  'helper calling transfer_ownership is refused (42501)'
);

-- Viewer (u03) calling transfer_ownership is refused
select pg_temp.as_user('cc100000-0000-4000-8000-000000000003'::uuid);
select throws_ok(
  $$select public.transfer_ownership(
      "circleId" => 'cc10c001-0000-4000-8000-000000000001'::uuid,
      "newOwnerId" => 'cc100000-0000-4000-8000-000000000003'::uuid
    )$$,
  '42501',
  null,
  'viewer calling transfer_ownership is refused (42501)'
);

-- Owner (u01) transferring ownership to non-member (u05) is refused
select pg_temp.as_user('cc100000-0000-4000-8000-000000000001'::uuid);
select throws_ok(
  $$select public.transfer_ownership(
      "circleId" => 'cc10c001-0000-4000-8000-000000000001'::uuid,
      "newOwnerId" => 'cc100000-0000-4000-8000-000000000005'::uuid
    )$$,
  '22023',
  null,
  'owner cannot transfer ownership to someone outside the circle'
);

-- Owner (u01) of Circle M (which has other members u02, u03) is refused account deletion with OWNER_MUST_TRANSFER
select throws_ok(
  $$select public.delete_own_account()$$,
  'P0001',
  'OWNER_MUST_TRANSFER',
  'owner of a circle with other members is refused account deletion with OWNER_MUST_TRANSFER'
);

select pg_temp.as_postgres();
select is(
  (select count(*)::int from auth.users where id = 'cc100000-0000-4000-8000-000000000001'::uuid),
  1,
  'nothing is deleted when OWNER_MUST_TRANSFER refuses account deletion'
);

-- Owner (u01) transfers ownership of Circle M to current member u02
select pg_temp.as_user('cc100000-0000-4000-8000-000000000001'::uuid);
select lives_ok(
  $$select public.transfer_ownership(
      "circleId" => 'cc10c001-0000-4000-8000-000000000001'::uuid,
      "newOwnerId" => 'cc100000-0000-4000-8000-000000000002'::uuid
    )$$,
  'owner can transfer ownership to a current circle member'
);

select pg_temp.as_postgres();
select is(
  (select count(*)::int from public.circle_members
    where circle_id = 'cc10c001-0000-4000-8000-000000000001'::uuid
      and role = 'owner'::public.member_role),
  1,
  'transfer_ownership leaves exactly one owner in the circle'
);

select is(
  (select user_id from public.circle_members
    where circle_id = 'cc10c001-0000-4000-8000-000000000001'::uuid
      and role = 'owner'::public.member_role),
  'cc100000-0000-4000-8000-000000000002'::uuid,
  'u02 is now the sole owner of Circle M'
);

select is(
  (select role::text from public.circle_members
    where circle_id = 'cc10c001-0000-4000-8000-000000000001'::uuid
      and user_id = 'cc100000-0000-4000-8000-000000000001'::uuid),
  'helper',
  'former owner u01 becomes helper after transfer_ownership'
);

select ok(
  exists (
    select 1 from public.log_entries
     where circle_id = 'cc10c001-0000-4000-8000-000000000001'::uuid
       and type = 'member'::public.log_type
       and ref_id = 'cc100000-0000-4000-8000-000000000002'::uuid
  ),
  'transfer_ownership writes a member log_entries row'
);

-- ============================================================================
-- Section 3: Non-owner account deletion (u03) -> 0 rows with u03's ID anywhere,
-- while surviving Circle M keeps its domain rows and care log with null user columns
-- ============================================================================

select pg_temp.as_user('cc100000-0000-4000-8000-000000000003'::uuid);
select lives_ok(
  $$select public.delete_own_account()$$,
  'non-owner member (u03) can delete their account'
);

select pg_temp.as_postgres();

select is(
  (select count(*)::int from public.users_profile where user_id = 'cc100000-0000-4000-8000-000000000003'::uuid)
  + (select count(*)::int from public.circle_members where user_id = 'cc100000-0000-4000-8000-000000000003'::uuid)
  + (select count(*)::int from public.push_tokens where user_id = 'cc100000-0000-4000-8000-000000000003'::uuid)
  + (select count(*)::int from public.entitlements where user_id = 'cc100000-0000-4000-8000-000000000003'::uuid)
  + (select count(*)::int from public.ai_calls where user_id = 'cc100000-0000-4000-8000-000000000003'::uuid),
  0,
  '0 rows remain for u03 in users_profile, circle_members, push_tokens, entitlements, and ai_calls (all DELETED)'
);

select is(
  (select count(*)::int from public.invites where used_by = 'cc100000-0000-4000-8000-000000000003'::uuid)
  + (select count(*)::int from public.circles where created_by = 'cc100000-0000-4000-8000-000000000003'::uuid)
  + (select count(*)::int from public.dose_events where acted_by = 'cc100000-0000-4000-8000-000000000003'::uuid)
  + (select count(*)::int from public.appointments where driver_user_id = 'cc100000-0000-4000-8000-000000000003'::uuid)
  + (select count(*)::int from public.tasks where assignee = 'cc100000-0000-4000-8000-000000000003'::uuid or done_by = 'cc100000-0000-4000-8000-000000000003'::uuid)
  + (select count(*)::int from public.visit_notes where created_by = 'cc100000-0000-4000-8000-000000000003'::uuid)
  + (select count(*)::int from public.log_entries where created_by = 'cc100000-0000-4000-8000-000000000003'::uuid or ref_id = 'cc100000-0000-4000-8000-000000000003'::uuid),
  0,
  '0 rows reference u03 in invites.used_by, circles.created_by, dose_events.acted_by, appointments.driver_user_id, tasks.assignee/done_by, visit_notes.created_by, or log_entries.created_by/ref_id (all SET TO NULL)'
);

-- Surviving Circle M keeps its dose_events, appointments, tasks, visit_notes, and log_entries
select is(
  (select count(*)::int from public.dose_events where id = 'cc103001-0000-4000-8000-000000000001'::uuid and acted_by is null)
  + (select count(*)::int from public.appointments where id = 'cc104001-0000-4000-8000-000000000001'::uuid and driver_user_id is null)
  + (select count(*)::int from public.tasks where id = 'cc105001-0000-4000-8000-000000000001'::uuid and assignee is null and done_by is null)
  + (select count(*)::int from public.visit_notes where id = 'cc106001-0000-4000-8000-000000000001'::uuid and created_by is null),
  4,
  'Circle M retains its dose_event, appointment, task, and visit_note with user columns set to null'
);

-- ============================================================================
-- Section 4: Solo owner account deletion (u04, only member of Circle S) ->
-- deletes Circle S and everything in it (medications, doses, appointments,
-- tasks, visit notes, log entries, invites, memberships)
-- ============================================================================

select pg_temp.as_user('cc100000-0000-4000-8000-000000000004'::uuid);
select lives_ok(
  $$select public.delete_own_account()$$,
  'solo owner (u04, only member of Circle S) can delete their account'
);

select pg_temp.as_postgres();

select is(
  (select count(*)::int from public.circles where id = 'cc10c004-0000-4000-8000-000000000004'::uuid),
  0,
  'solo owner''s circle (Circle S) is deleted'
);

select is(
  (select count(*)::int from public.circle_members where circle_id = 'cc10c004-0000-4000-8000-000000000004'::uuid)
  + (select count(*)::int from public.medications where circle_id = 'cc10c004-0000-4000-8000-000000000004'::uuid)
  + (select count(*)::int from public.dose_events where circle_id = 'cc10c004-0000-4000-8000-000000000004'::uuid)
  + (select count(*)::int from public.appointments where circle_id = 'cc10c004-0000-4000-8000-000000000004'::uuid)
  + (select count(*)::int from public.tasks where circle_id = 'cc10c004-0000-4000-8000-000000000004'::uuid)
  + (select count(*)::int from public.visit_notes where circle_id = 'cc10c004-0000-4000-8000-000000000004'::uuid)
  + (select count(*)::int from public.invites where circle_id = 'cc10c004-0000-4000-8000-000000000004'::uuid),
  0,
  'all medications, dose_events, appointments, tasks, visit_notes, invites, and circle_members in Circle S are deleted'
);

select is(
  (select count(*)::int from public.log_entries where circle_id = 'cc10c004-0000-4000-8000-000000000004'::uuid),
  0,
  'all log_entries for deleted Circle S are removed via circle cascade'
);

select is(
  (select count(*)::int from public.users_profile where user_id = 'cc100000-0000-4000-8000-000000000004'::uuid)
  + (select count(*)::int from public.push_tokens where user_id = 'cc100000-0000-4000-8000-000000000004'::uuid)
  + (select count(*)::int from public.entitlements where user_id = 'cc100000-0000-4000-8000-000000000004'::uuid)
  + (select count(*)::int from public.ai_calls where user_id = 'cc100000-0000-4000-8000-000000000004'::uuid),
  0,
  '0 rows remain for solo owner u04 in users_profile, push_tokens, entitlements, and ai_calls'
);

-- ============================================================================
-- Section 5: log_entries remains insert-only (nobody can delete single entries
-- while a circle exists, even postgres/service_role)
-- ============================================================================

select throws_ok(
  $$delete from public.log_entries
     where circle_id = 'cc10c001-0000-4000-8000-000000000001'::uuid$$,
  '42501',
  null,
  'single log_entries rows in an existing circle still cannot be deleted even by postgres/service_role'
);

select * from finish();

rollback;
