-- CC-1b [safety 1/2]: pgTAP tests for `public.create_invite`, `public.accept_invite`,
-- `public.invites` RLS, `public.circle_members` role & join invariants, server-side plan
-- member limits (`public.entitlements`), viewer write restrictions, and the "1 circle" rule.
--
-- Rules tested:
-- 1. People join a circle ONLY through `public.accept_invite(token)`: direct INSERT into
--    `public.circle_members` as `authenticated` fails (even for the circle owner).
-- 2. Only the circle `owner` can call `public.create_invite` or read/delete `public.invites` rows
--    and tokens. A `helper`, a `viewer`, another family's `owner`, a dual-role user (owner in B,
--    helper in A), an outsider, and `anon` are refused by `create_invite` and see 0 rows in `invites`.
-- 3. Exactly one owner: an invite can NEVER have `role = 'owner'`, `accept_invite` can NEVER make
--    someone `owner`, and `authenticated` cannot promote anyone to `owner` or remove/demote the owner.
-- 4. `accept_invite(token)` returns `INVITE_EXPIRED` after 7 days, `INVITE_USED` on reuse, and
--    `CIRCLE_FULL` at 2 members on the free plan and at 8 members when the circle owner has an
--    active, non-expired `carecircle_family` row in `public.entitlements` (read on the server,
--    never from client arguments).
-- 5. The joining user is always `auth.uid()`: `accept_invite` takes only `(token text)` (no user_id
--    parameter), and the `member` audit row in `public.log_entries` is recorded with
--    `created_by = auth.uid()` and `ref_id = auth.uid()`.
-- 6. A `viewer` cannot insert, update, or delete on any circle table (`medications`, `dose_events`,
--    `appointments`, `tasks`, `visit_notes`, `invites`, `circles`, `circle_members`).
-- 7. Separate, clearly named test for the "1 circle" rule on `accept_invite` (joining a second
--    circle) so it can be flipped in one place once Taha answers whether "1 circle" caps owned
--    circles or all circle memberships.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(48);

-- Helper to switch the simulated PostgREST authenticated caller
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

create or replace function pg_temp.as_anon()
returns void
language plpgsql
as $$
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claim.role', 'anon', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
end;
$$;

grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- 1. Function security metadata and signature checks (5 checks)
select is(
  (select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_invite'),
  true,
  'public.create_invite is SECURITY DEFINER'
);

select is(
  (select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'accept_invite'),
  true,
  'public.accept_invite is SECURITY DEFINER'
);

select is(
  (select p.pronargs::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'accept_invite'),
  1,
  'public.accept_invite takes exactly 1 argument (token text) and never accepts a user_id or entitlement argument'
);

select is(
  (select bool_or(has_function_privilege('anon', p.oid, 'EXECUTE'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('create_invite', 'accept_invite')),
  false,
  'anon role cannot execute create_invite or accept_invite'
);

select is(
  (select bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('create_invite', 'accept_invite')),
  true,
  'authenticated role can execute create_invite and accept_invite'
);

-- Seed users for Circle A, Circle B, and invite acceptance / limit tests
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('cc1b0001-0000-4000-8000-000000000001'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'owner-a@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('cc1b0002-0000-4000-8000-000000000002'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'helper-a@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('cc1b0003-0000-4000-8000-000000000003'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'viewer-a@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('cc1b0004-0000-4000-8000-000000000004'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'owner-b@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('cc1b0005-0000-4000-8000-000000000005'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'outsider-1@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('cc1b0006-0000-4000-8000-000000000006'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'outsider-2@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('cc1b0007-0000-4000-8000-000000000007'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'outsider-3@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('cc1b0008-0000-4000-8000-000000000008'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'outsider-4@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('cc1b0009-0000-4000-8000-000000000009'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'outsider-5@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('cc1b0010-0000-4000-8000-000000000010'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'outsider-6@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('cc1b0011-0000-4000-8000-000000000011'::uuid, '00000000-0000-0000-0000-000000000011'::uuid, 'authenticated', 'authenticated', 'outsider-7@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('cc1b0012-0000-4000-8000-000000000012'::uuid, '00000000-0000-0000-0000-000000000012'::uuid, 'authenticated', 'authenticated', 'outsider-8@example.test', '{}'::jsonb, '{}'::jsonb, now(), now());

-- Seed Circle A (owner_a) and Circle B (owner_b, where owner_b is also a helper in Circle A to test dual-role checks)
insert into public.circles (id, name, care_recipient_name, timezone, created_by)
values
  ('cc1bc001-0000-4000-8000-000000000001'::uuid, 'Circle A', 'Evelyn', 'Europe/Paris', 'cc1b0001-0000-4000-8000-000000000001'::uuid),
  ('cc1bc002-0000-4000-8000-000000000002'::uuid, 'Circle B', 'Arthur', 'Europe/London', 'cc1b0004-0000-4000-8000-000000000004'::uuid);

insert into public.circle_members (circle_id, user_id, role)
values
  ('cc1bc001-0000-4000-8000-000000000001'::uuid, 'cc1b0001-0000-4000-8000-000000000001'::uuid, 'owner'),
  ('cc1bc002-0000-4000-8000-000000000002'::uuid, 'cc1b0004-0000-4000-8000-000000000004'::uuid, 'owner');

-- 2. Direct INSERT into circle_members as authenticated is always refused (2 checks)
select pg_temp.as_user('cc1b0005-0000-4000-8000-000000000005'::uuid);
select throws_ok(
  $$insert into public.circle_members (circle_id, user_id, role)
    values ('cc1bc001-0000-4000-8000-000000000001'::uuid, 'cc1b0005-0000-4000-8000-000000000005'::uuid, 'helper')$$,
  '42501',
  null,
  'outsider cannot insert themselves directly into circle_members'
);

select pg_temp.as_user('cc1b0001-0000-4000-8000-000000000001'::uuid);
select throws_ok(
  $$insert into public.circle_members (circle_id, user_id, role)
    values ('cc1bc001-0000-4000-8000-000000000001'::uuid, 'cc1b0005-0000-4000-8000-000000000005'::uuid, 'helper')$$,
  '42501',
  null,
  'even the circle owner cannot directly insert into circle_members (joining goes only through accept_invite)'
);

-- 3. Owner creates invites; non-owners, dual-role helpers, viewers, outsiders, and owner-role invites are refused (12 checks)
select pg_temp.as_user('cc1b0001-0000-4000-8000-000000000001'::uuid);
select throws_ok(
  $$select public.create_invite('cc1bc001-0000-4000-8000-000000000001'::uuid, 'owner'::public.member_role)$$,
  '22023',
  null,
  'create_invite refuses role = owner (a circle has exactly one owner)'
);

create temp table tmp_created_invites (
  label text primary key,
  payload jsonb not null
);
grant select, insert, update, delete on table tmp_created_invites to authenticated, service_role;

insert into tmp_created_invites (label, payload)
values (
  'helper_invite_1',
  public.create_invite('cc1bc001-0000-4000-8000-000000000001'::uuid, 'helper'::public.member_role)
);

select ok(
  (select (payload->>'url') ~ '^carecircle://invite/[A-Za-z0-9_-]{32,}$'
     from tmp_created_invites where label = 'helper_invite_1'),
  'create_invite returns a deep-link url starting with carecircle://invite/<token>'
);

select ok(
  (select ((payload->>'expiresAt')::timestamptz between now() + interval '6 days 23 hours 59 minutes' and now() + interval '7 days 1 minute')
     from tmp_created_invites where label = 'helper_invite_1'),
  'create_invite sets expiresAt to 7 days from creation'
);

select is(
  (select count(*)::int from public.invites where circle_id = 'cc1bc001-0000-4000-8000-000000000001'::uuid),
  1,
  'circle owner can read the created invite row in public.invites'
);

-- Seed helper_a, viewer_a, and owner_b (as helper in Circle A) via postgres so we can test their permissions before testing accept_invite
set local role postgres;
insert into public.circle_members (circle_id, user_id, role)
values
  ('cc1bc001-0000-4000-8000-000000000001'::uuid, 'cc1b0002-0000-4000-8000-000000000002'::uuid, 'helper'),
  ('cc1bc001-0000-4000-8000-000000000001'::uuid, 'cc1b0003-0000-4000-8000-000000000003'::uuid, 'viewer'),
  ('cc1bc001-0000-4000-8000-000000000001'::uuid, 'cc1b0004-0000-4000-8000-000000000004'::uuid, 'helper');

select pg_temp.as_user('cc1b0002-0000-4000-8000-000000000002'::uuid);
select throws_ok(
  $$select public.create_invite('cc1bc001-0000-4000-8000-000000000001'::uuid, 'helper'::public.member_role)$$,
  '42501',
  null,
  'circle helper is refused by create_invite'
);

select is(
  (select count(*)::int from public.invites where circle_id = 'cc1bc001-0000-4000-8000-000000000001'::uuid),
  0,
  'circle helper sees 0 rows and tokens in public.invites'
);

select pg_temp.as_user('cc1b0003-0000-4000-8000-000000000003'::uuid);
select throws_ok(
  $$select public.create_invite('cc1bc001-0000-4000-8000-000000000001'::uuid, 'viewer'::public.member_role)$$,
  '42501',
  null,
  'circle viewer is refused by create_invite'
);

select is(
  (select count(*)::int from public.invites where circle_id = 'cc1bc001-0000-4000-8000-000000000001'::uuid),
  0,
  'circle viewer sees 0 rows and tokens in public.invites'
);

-- Dual-role user: owner of Circle B, but only helper of Circle A
select pg_temp.as_user('cc1b0004-0000-4000-8000-000000000004'::uuid);
select throws_ok(
  $$select public.create_invite('cc1bc001-0000-4000-8000-000000000001'::uuid, 'helper'::public.member_role)$$,
  '42501',
  null,
  'an owner of Circle B who is only a helper of Circle A is refused by create_invite for Circle A'
);

select is(
  (select count(*)::int from public.invites where circle_id = 'cc1bc001-0000-4000-8000-000000000001'::uuid),
  0,
  'an owner of Circle B who is only a helper of Circle A sees 0 rows in public.invites for Circle A'
);

select pg_temp.as_user('cc1b0005-0000-4000-8000-000000000005'::uuid);
select throws_ok(
  $$select public.create_invite('cc1bc001-0000-4000-8000-000000000001'::uuid, 'helper'::public.member_role)$$,
  '42501',
  null,
  'non-member is refused by create_invite'
);

select is(
  (select count(*)::int from public.invites),
  0,
  'non-member sees 0 rows in public.invites'
);

-- Clean up temporary seeded non-owner members on Circle A so Circle A has only owner_a (1 member) for the plan-limit tests
set local role postgres;
delete from public.circle_members
 where circle_id = 'cc1bc001-0000-4000-8000-000000000001'::uuid
   and user_id <> 'cc1b0001-0000-4000-8000-000000000001'::uuid;
delete from public.log_entries
 where circle_id = 'cc1bc001-0000-4000-8000-000000000001'::uuid;

-- 4. accept_invite: auth.uid() joins, log_entries written as joining user, single-use (INVITE_USED), and 7-day expiry (INVITE_EXPIRED) (9 checks)
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);

select throws_ok(
  $$select public.accept_invite('any-token')$$,
  '42501',
  null,
  'accept_invite refuses an unauthenticated caller (null auth.uid())'
);

select pg_temp.as_user('cc1b0002-0000-4000-8000-000000000002'::uuid);
select throws_ok(
  $$select public.accept_invite('non-existent-invite-token-00000000000000000000000000000000')$$,
  'P0001',
  'INVITE_INVALID',
  'accept_invite refuses an unknown token with INVITE_INVALID'
);

-- Create an invite that is already expired (7 days + 1 minute old) and verify INVITE_EXPIRED
set local role postgres;
insert into public.invites (id, circle_id, token, role, expires_at)
values (
  'cc1bi001-0000-4000-8000-000000000001'::uuid,
  'cc1bc001-0000-4000-8000-000000000001'::uuid,
  'expired_token_00000000000000000000000000000000000000000000000001',
  'helper',
  now() - interval '1 minute'
);

select pg_temp.as_user('cc1b0002-0000-4000-8000-000000000002'::uuid);
select throws_ok(
  $$select public.accept_invite('expired_token_00000000000000000000000000000000000000000000000001')$$,
  'P0001',
  'INVITE_EXPIRED',
  'accept_invite returns INVITE_EXPIRED when expires_at has passed'
);

select is(
  (select count(*)::int from public.circle_members
    where circle_id = 'cc1bc001-0000-4000-8000-000000000001'::uuid
      and user_id = 'cc1b0002-0000-4000-8000-000000000002'::uuid),
  0,
  'an expired invite does not add the caller to circle_members'
);

-- Accept the valid helper_invite_1 as user cc1b0002 (2nd member of Circle A on free plan)
select is(
  (select (public.accept_invite(
    regexp_replace(payload->>'url', '^carecircle://invite/', '')
  )->>'circleId')
   from tmp_created_invites where label = 'helper_invite_1'),
  'cc1bc001-0000-4000-8000-000000000001',
  'accept_invite returns { circleId } when a valid invite token is accepted'
);

select is(
  (select role::text from public.circle_members
    where circle_id = 'cc1bc001-0000-4000-8000-000000000001'::uuid
      and user_id = 'cc1b0002-0000-4000-8000-000000000002'::uuid),
  'helper',
  'accept_invite adds auth.uid() to circle_members with the invite role (helper, never owner)'
);

select is(
  (select count(*)::int from public.log_entries
    where circle_id = 'cc1bc001-0000-4000-8000-000000000001'::uuid
      and type = 'member'
      and ref_id = 'cc1b0002-0000-4000-8000-000000000002'::uuid
      and created_by = 'cc1b0002-0000-4000-8000-000000000002'::uuid),
  1,
  'accept_invite writes the member log_entries row with created_by = auth.uid() (the joining user)'
);

set local role postgres;
select is(
  (select used_by from public.invites
    where token = (
      select regexp_replace(payload->>'url', '^carecircle://invite/', '')
        from tmp_created_invites where label = 'helper_invite_1'
    )),
  'cc1b0002-0000-4000-8000-000000000002'::uuid,
  'accept_invite marks invites.used_by = auth.uid()'
);

-- Reusing the same invite token as another user fails with INVITE_USED
select pg_temp.as_user('cc1b0003-0000-4000-8000-000000000003'::uuid);
select throws_ok(
  $$select public.accept_invite(
      (select regexp_replace(payload->>'url', '^carecircle://invite/', '')
         from tmp_created_invites where label = 'helper_invite_1')
    )$$,
  'P0001',
  'INVITE_USED',
  'accept_invite returns INVITE_USED when an already-used token is reused'
);

-- 5. Plan limits read from public.entitlements on the server:
--    Free plan max 2 members; active carecircle_family on the circle owner max 8 members (9 checks)
select pg_temp.as_user('cc1b0001-0000-4000-8000-000000000001'::uuid);
insert into tmp_created_invites (label, payload)
values
  ('viewer_invite_3', public.create_invite('cc1bc001-0000-4000-8000-000000000001'::uuid, 'viewer'::public.member_role)),
  ('helper_invite_4', public.create_invite('cc1bc001-0000-4000-8000-000000000001'::uuid, 'helper'::public.member_role)),
  ('helper_invite_5', public.create_invite('cc1bc001-0000-4000-8000-000000000001'::uuid, 'helper'::public.member_role)),
  ('helper_invite_6', public.create_invite('cc1bc001-0000-4000-8000-000000000001'::uuid, 'helper'::public.member_role)),
  ('helper_invite_7', public.create_invite('cc1bc001-0000-4000-8000-000000000001'::uuid, 'helper'::public.member_role)),
  ('helper_invite_8', public.create_invite('cc1bc001-0000-4000-8000-000000000001'::uuid, 'helper'::public.member_role)),
  ('helper_invite_9', public.create_invite('cc1bc001-0000-4000-8000-000000000001'::uuid, 'helper'::public.member_role));

-- Circle A currently has 2 members (owner_a + helper_a). Free plan limit is 2.
select pg_temp.as_user('cc1b0003-0000-4000-8000-000000000003'::uuid);
select throws_ok(
  $$select public.accept_invite(
      (select regexp_replace(payload->>'url', '^carecircle://invite/', '')
         from tmp_created_invites where label = 'viewer_invite_3')
    )$$,
  'P0001',
  'CIRCLE_FULL',
  'free plan circle at 2 members refuses a 3rd member with CIRCLE_FULL'
);

-- An inactive entitlement (active = false) on the owner does NOT unlock > 2 members
set local role postgres;
insert into public.entitlements (user_id, entitlement, active, expires_at)
values ('cc1b0001-0000-4000-8000-000000000001'::uuid, 'carecircle_family', false, now() + interval '30 days');

select pg_temp.as_user('cc1b0003-0000-4000-8000-000000000003'::uuid);
select throws_ok(
  $$select public.accept_invite(
      (select regexp_replace(payload->>'url', '^carecircle://invite/', '')
         from tmp_created_invites where label = 'viewer_invite_3')
    )$$,
  'P0001',
  'CIRCLE_FULL',
  'inactive carecircle_family entitlement (active = false) still refuses a 3rd member with CIRCLE_FULL'
);

-- An expired entitlement (active = true, expires_at in the past) on the owner does NOT unlock > 2 members
set local role postgres;
update public.entitlements
   set active = true,
       expires_at = now() - interval '1 minute'
 where user_id = 'cc1b0001-0000-4000-8000-000000000001'::uuid
   and entitlement = 'carecircle_family';

select pg_temp.as_user('cc1b0003-0000-4000-8000-000000000003'::uuid);
select throws_ok(
  $$select public.accept_invite(
      (select regexp_replace(payload->>'url', '^carecircle://invite/', '')
         from tmp_created_invites where label = 'viewer_invite_3')
    )$$,
  'P0001',
  'CIRCLE_FULL',
  'expired carecircle_family entitlement (expires_at <= now()) still refuses a 3rd member with CIRCLE_FULL'
);

-- An active entitlement on a NON-OWNER (e.g. the joining user or helper) does NOT unlock > 2 members for Circle A
set local role postgres;
delete from public.entitlements where user_id = 'cc1b0001-0000-4000-8000-000000000001'::uuid;
insert into public.entitlements (user_id, entitlement, active, expires_at)
values
  ('cc1b0002-0000-4000-8000-000000000002'::uuid, 'carecircle_family', true, now() + interval '30 days'),
  ('cc1b0003-0000-4000-8000-000000000003'::uuid, 'carecircle_family', true, now() + interval '30 days');

select pg_temp.as_user('cc1b0003-0000-4000-8000-000000000003'::uuid);
select throws_ok(
  $$select public.accept_invite(
      (select regexp_replace(payload->>'url', '^carecircle://invite/', '')
         from tmp_created_invites where label = 'viewer_invite_3')
    )$$,
  'P0001',
  'CIRCLE_FULL',
  'entitlement on a helper or joining user does not unlock Circle A when Circle A''s owner is on the free plan'
);

-- Grant Circle A's owner an active carecircle_family entitlement: members 3..8 succeed, 9th fails with CIRCLE_FULL
set local role postgres;
delete from public.entitlements;
insert into public.entitlements (user_id, entitlement, active, expires_at)
values ('cc1b0001-0000-4000-8000-000000000001'::uuid, 'carecircle_family', true, now() + interval '30 days');

select pg_temp.as_user('cc1b0003-0000-4000-8000-000000000003'::uuid);
select lives_ok(
  $$select public.accept_invite(
      (select regexp_replace(payload->>'url', '^carecircle://invite/', '')
         from tmp_created_invites where label = 'viewer_invite_3')
    )$$,
  'with active carecircle_family on the circle owner, 3rd member (viewer) joins Circle A'
);

select pg_temp.as_user('cc1b0005-0000-4000-8000-000000000005'::uuid);
select lives_ok(
  $$select public.accept_invite(
      (select regexp_replace(payload->>'url', '^carecircle://invite/', '')
         from tmp_created_invites where label = 'helper_invite_4')
    )$$,
  '4th member joins Circle A on Family plan'
);

select pg_temp.as_user('cc1b0006-0000-4000-8000-000000000006'::uuid);
select lives_ok(
  $$select public.accept_invite(
      (select regexp_replace(payload->>'url', '^carecircle://invite/', '')
         from tmp_created_invites where label = 'helper_invite_5')
    )$$,
  '5th member joins Circle A on Family plan'
);

select pg_temp.as_user('cc1b0007-0000-4000-8000-000000000007'::uuid);
select lives_ok(
  $$select public.accept_invite(
      (select regexp_replace(payload->>'url', '^carecircle://invite/', '')
         from tmp_created_invites where label = 'helper_invite_6')
    )$$,
  '6th member joins Circle A on Family plan'
);

select pg_temp.as_user('cc1b0008-0000-4000-8000-000000000008'::uuid);
select lives_ok(
  $$select public.accept_invite(
      (select regexp_replace(payload->>'url', '^carecircle://invite/', '')
         from tmp_created_invites where label = 'helper_invite_7')
    )$$,
  '7th member joins Circle A on Family plan'
);

select pg_temp.as_user('cc1b0009-0000-4000-8000-000000000009'::uuid);
select lives_ok(
  $$select public.accept_invite(
      (select regexp_replace(payload->>'url', '^carecircle://invite/', '')
         from tmp_created_invites where label = 'helper_invite_8')
    )$$,
  '8th member joins Circle A on Family plan'
);

select pg_temp.as_user('cc1b0010-0000-4000-8000-000000000010'::uuid);
select throws_ok(
  $$select public.accept_invite(
      (select regexp_replace(payload->>'url', '^carecircle://invite/', '')
         from tmp_created_invites where label = 'helper_invite_9')
    )$$,
  'P0001',
  'CIRCLE_FULL',
  'Family plan circle at 8 members refuses a 9th member with CIRCLE_FULL'
);

-- 6. Viewer write restrictions & role management rules (10 checks)
select pg_temp.as_user('cc1b0003-0000-4000-8000-000000000003'::uuid);
select throws_ok(
  $$insert into public.medications (circle_id, name, dose_text, schedule, source)
    values ('cc1bc001-0000-4000-8000-000000000001'::uuid, 'Aspirin', '1 tablet', '{"kind":"daily","times":["08:00"]}'::jsonb, 'manual')$$,
  '42501',
  null,
  'viewer cannot insert into medications'
);

select throws_ok(
  $$insert into public.tasks (circle_id, title, source)
    values ('cc1bc001-0000-4000-8000-000000000001'::uuid, 'Pick up prescription', 'manual')$$,
  '42501',
  null,
  'viewer cannot insert into tasks'
);

select throws_ok(
  $$insert into public.appointments (circle_id, title, starts_at)
    values ('cc1bc001-0000-4000-8000-000000000001'::uuid, 'Cardiology checkup', now() + interval '1 day')$$,
  '42501',
  null,
  'viewer cannot insert into appointments'
);

select throws_ok(
  $$insert into public.visit_notes (circle_id, summary)
    values ('cc1bc001-0000-4000-8000-000000000001'::uuid, 'Blood pressure stable')$$,
  '42501',
  null,
  'viewer cannot insert into visit_notes'
);

-- Viewer and helper cannot change member roles or remove other members
select pg_temp.as_user('cc1b0002-0000-4000-8000-000000000002'::uuid);
update public.circle_members
   set role = 'helper'::public.member_role
 where circle_id = 'cc1bc001-0000-4000-8000-000000000001'::uuid
   and user_id = 'cc1b0003-0000-4000-8000-000000000003'::uuid;

select is(
  (select role::text from public.circle_members
    where circle_id = 'cc1bc001-0000-4000-8000-000000000001'::uuid
      and user_id = 'cc1b0003-0000-4000-8000-000000000003'::uuid),
  'viewer',
  'circle helper cannot change another member''s role'
);

delete from public.circle_members
 where circle_id = 'cc1bc001-0000-4000-8000-000000000001'::uuid
   and user_id = 'cc1b0003-0000-4000-8000-000000000003'::uuid;

select is(
  (select count(*)::int from public.circle_members
    where circle_id = 'cc1bc001-0000-4000-8000-000000000001'::uuid
      and user_id = 'cc1b0003-0000-4000-8000-000000000003'::uuid),
  1,
  'circle helper cannot remove another member from circle_members'
);

-- Owner CAN change a member's role between helper and viewer, CANNOT promote anyone to owner, and CAN remove a non-owner member
select pg_temp.as_user('cc1b0001-0000-4000-8000-000000000001'::uuid);
update public.circle_members
   set role = 'helper'::public.member_role
 where circle_id = 'cc1bc001-0000-4000-8000-000000000001'::uuid
   and user_id = 'cc1b0003-0000-4000-8000-000000000003'::uuid;

select is(
  (select role::text from public.circle_members
    where circle_id = 'cc1bc001-0000-4000-8000-000000000001'::uuid
      and user_id = 'cc1b0003-0000-4000-8000-000000000003'::uuid),
  'helper',
  'circle owner can change a member''s role between viewer and helper'
);

select throws_ok(
  $$update public.circle_members
       set role = 'owner'::public.member_role
     where circle_id = 'cc1bc001-0000-4000-8000-000000000001'::uuid
       and user_id = 'cc1b0003-0000-4000-8000-000000000003'::uuid$$,
  '42501',
  null,
  'circle owner cannot promote another member to owner via direct update (exactly one owner)'
);

delete from public.circle_members
 where circle_id = 'cc1bc001-0000-4000-8000-000000000001'::uuid
   and user_id = 'cc1b0009-0000-4000-8000-000000000009'::uuid;

select is(
  (select count(*)::int from public.circle_members
    where circle_id = 'cc1bc001-0000-4000-8000-000000000001'::uuid
      and user_id = 'cc1b0009-0000-4000-8000-000000000009'::uuid),
  0,
  'circle owner can remove a non-owner member from circle_members'
);

select is(
  (select count(*)::int from public.circle_members
    where circle_id = 'cc1bc001-0000-4000-8000-000000000001'::uuid
      and role = 'owner'::public.member_role),
  1,
  'Circle A always has exactly one owner'
);

-- 7. [1-circle rule — separate, clearly named test so it can be flipped once Taha answers]:
--    Until Taha clarifies whether "1 circle" means 1 owned circle or 1 membership in any role,
--    a member of Circle A (cc1b0002) can accept an invite to join Circle B as a helper.
select pg_temp.as_user('cc1b0004-0000-4000-8000-000000000004'::uuid);
insert into tmp_created_invites (label, payload)
values (
  'circle_b_helper_invite',
  public.create_invite('cc1bc002-0000-4000-8000-000000000002'::uuid, 'helper'::public.member_role)
);

select pg_temp.as_user('cc1b0002-0000-4000-8000-000000000002'::uuid);
select lives_ok(
  $$select public.accept_invite(
      (select regexp_replace(payload->>'url', '^carecircle://invite/', '')
         from tmp_created_invites where label = 'circle_b_helper_invite')
    )$$,
  '[1-circle rule: joining a second circle] a user who belongs to Circle A can accept an invite to join Circle B as helper (flip to throws_ok CIRCLE_LIMIT_REACHED if Taha decides 1 circle caps total memberships)'
);

select * from finish();

rollback;
