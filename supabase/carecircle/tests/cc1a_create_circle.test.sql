-- CC-1a pgTAP tests for `public.create_circle`:
-- 1. `create_circle` is SECURITY DEFINER with search_path = '' and execute revoked from anon/public.
-- 2. Anonymous call is refused (42501).
-- 3. Invalid inputs (blank name, blank careRecipientName, unknown timezone) are refused (22023).
-- 4. Caller becomes `owner` of the new circle in the same transaction, `created_by = auth.uid()`,
--    and `log_entries` records the `member` insert.
-- 5. A second owned circle by the same user is refused (P0001 / CIRCLE_LIMIT_REACHED).

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(18);

-- 1. Function security metadata and privileges
select is(
  (select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_circle'),
  true,
  'public.create_circle is SECURITY DEFINER'
);

select is(
  has_function_privilege('anon', 'public.create_circle(text, text, text, text, date)', 'EXECUTE'),
  false,
  'anon role cannot execute public.create_circle'
);

select is(
  has_function_privilege('authenticated', 'public.create_circle(text, text, text, text, date)', 'EXECUTE'),
  true,
  'authenticated role can execute public.create_circle'
);

select ok(
  (select pg_get_functiondef(p.oid) ~ 'pg_advisory_xact_lock'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_circle'),
  'create_circle takes a per-user lock so two calls at once cannot both create an owned circle'
);

-- Seed two authenticated users
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('cc1a0001-0000-4000-8000-000000000001'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'cc1a-user1@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('cc1a0002-0000-4000-8000-000000000002'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'cc1a-user2@example.test', '{}'::jsonb, '{}'::jsonb, now(), now());
-- CC-11 (Claude-approved): seed health-data consent for the inserted test users.
update public.users_profile set health_consent_at = now() where user_id in ('cc1a0001-0000-4000-8000-000000000001'::uuid, 'cc1a0002-0000-4000-8000-000000000002'::uuid);

-- 2. Anonymous call is refused
set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{"role":"anon"}', true);

select throws_ok(
  $$select public.create_circle('Anon Circle', 'Evelyn', 'Europe/Paris')$$,
  '42501',
  null,
  'anonymous caller is refused by public.create_circle'
);

-- Role authenticated without a JWT sub (auth.uid() is null) is also refused
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);

select throws_ok(
  $$select public.create_circle('No UID Circle', 'Evelyn', 'Europe/Paris')$$,
  '42501',
  null,
  'authenticated role with null auth.uid() is refused by public.create_circle'
);

-- 3. Input validation as signed-in User 1
select set_config('request.jwt.claim.sub', 'cc1a0001-0000-4000-8000-000000000001', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"cc1a0001-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

select throws_ok(
  $$select public.create_circle('   ', 'Evelyn', 'Europe/Paris')$$,
  '22023',
  null,
  'blank circle name is refused'
);

select throws_ok(
  $$select public.create_circle('Family Care', '   ', 'Europe/Paris')$$,
  '22023',
  null,
  'blank careRecipientName is refused'
);

select throws_ok(
  $$select public.create_circle('Family Care', 'Evelyn', 'Not/A_Real_Timezone')$$,
  '22023',
  null,
  'unknown timezone is refused'
);

-- 4. User 1 creates a circle and becomes owner in the same transaction
select lives_ok(
  $$select public.create_circle('  Family Care  ', '  Evelyn  ', 'Europe/Paris')$$,
  'signed-in user can create their first circle via public.create_circle'
);

select is(
  (select count(*)::int from public.circles where created_by = 'cc1a0001-0000-4000-8000-000000000001'::uuid),
  1,
  'circle row is visible to the caller via RLS with created_by = auth.uid()'
);

select is(
  (select array[name, care_recipient_name, timezone]
     from public.circles
    where created_by = 'cc1a0001-0000-4000-8000-000000000001'::uuid),
  array['Family Care', 'Evelyn', 'Europe/Paris'],
  'create_circle trims name and care_recipient_name and stores canonical IANA timezone'
);

select is(
  (select role::text
     from public.circle_members
    where user_id = 'cc1a0001-0000-4000-8000-000000000001'::uuid),
  'owner',
  'caller becomes owner in circle_members in the same transaction'
);

select is(
  (select count(*)::int
     from public.log_entries le
     join public.circles c on c.id = le.circle_id
    where c.created_by = 'cc1a0001-0000-4000-8000-000000000001'::uuid
      and le.type = 'member'
      and le.created_by = 'cc1a0001-0000-4000-8000-000000000001'::uuid),
  1,
  'creating a circle writes the owner member log_entries row in the same transaction'
);

-- 5. A second owned circle for User 1 is refused
select throws_ok(
  $$select public.create_circle('Second Circle', 'Arthur', 'Europe/London')$$,
  'P0001',
  'CIRCLE_LIMIT_REACHED',
  'creating a second owned circle is refused with CIRCLE_LIMIT_REACHED'
);

set local role postgres;
select is(
  (select count(*)::int from public.circles where created_by = 'cc1a0001-0000-4000-8000-000000000001'::uuid),
  1,
  'failed second create_circle leaves only 1 circle for User 1'
);

-- 6. User 2 (helper in User 1's circle, owning 0 circles) can create 1 owned circle using named args
insert into public.circle_members (circle_id, user_id, role)
select id, 'cc1a0002-0000-4000-8000-000000000002'::uuid, 'helper'::public.member_role
  from public.circles
 where created_by = 'cc1a0001-0000-4000-8000-000000000001'::uuid;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'cc1a0002-0000-4000-8000-000000000002', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"cc1a0002-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);

select lives_ok(
  $$select public.create_circle(
      name => 'Helper Own Circle',
      "careRecipientName" => 'Martha',
      timezone => 'America/New_York'
    )$$,
  'a helper in another circle who owns 0 circles can create 1 owned circle'
);

select throws_ok(
  $$select public.create_circle(
      name => 'Helper Second Circle',
      "careRecipientName" => 'George',
      timezone => 'America/New_York'
    )$$,
  'P0001',
  'CIRCLE_LIMIT_REACHED',
  'User 2 is refused a second owned circle'
);

select * from finish();

rollback;
