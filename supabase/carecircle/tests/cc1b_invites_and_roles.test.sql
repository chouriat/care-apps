-- CC-1b [safety 1/2]: pgTAP tests for `public.create_invite`, `public.accept_invite`,
-- `public.invites` RLS, `public.circle_members` role & join invariants, server-side plan
-- member limits (`public.entitlements`), viewer write restrictions, member names on the
-- /circle screen, and the "1 circle" rule.
--
-- Rules tested:
-- 1. People join a circle ONLY through `public.accept_invite(token)`: direct INSERT into
--    `public.circle_members` as `authenticated` fails (even for the circle owner).
-- 2. Only the circle `owner` can call `public.create_invite` or read/delete `public.invites` rows
--    and tokens. A `helper`, a `viewer`, a dual-role user (owner in B, helper in C), an outsider,
--    a caller with no user id and `anon` are refused by `create_invite` and see 0 rows in `invites`.
-- 3. Exactly one owner: an invite can NEVER have `role = 'owner'`, `accept_invite` can NEVER make
--    someone `owner` (nor demote the owner who opens their own link), and `authenticated` cannot
--    promote anyone to `owner` or remove/demote the owner.
-- 4. `accept_invite(token)` returns `INVITE_INVALID` for an unknown or revoked token,
--    `INVITE_EXPIRED` after 7 days, `INVITE_USED` on reuse, and `CIRCLE_FULL` at 2 members on the
--    free plan and at 8 members when the circle OWNER (the `owner` row in `circle_members`, not
--    `circles.created_by`) has an active, non-expired `carecircle_family` row in
--    `public.entitlements` (read on the server, never from client arguments). A refused call
--    changes nothing: no member, no log line, and the invite stays usable.
-- 5. The joining user is always `auth.uid()`: `accept_invite` takes only `(token text)` (no user_id
--    parameter), and the `member` audit row in `public.log_entries` is recorded with
--    `created_by = auth.uid()` and `ref_id = auth.uid()`.
-- 6. The argument names are the ones the app sends through PostgREST (`circleId`, `role`, `token`;
--    spec "APIs"), and both functions pin `search_path = ''`.
-- 7. The /circle member list can show names: a member can read the `users_profile` row of people
--    who share a circle with them, and nobody else's.
-- 8. Separate, clearly named test for the "1 circle" rule on `accept_invite` (joining a second
--    circle) so it can be flipped in one place once Taha answers whether "1 circle" caps owned
--    circles or all circle memberships.
--
-- Circles used:
--   A: owner u01. Invite flow and plan limits (only u01 at the start).
--   B: owner u04. The "1 circle" test.
--   C: owner u11, helper u12, viewer u13, and u04 (owner of B) as helper. Who may create and read invites.
--   D: owner u14. Revoked invites and a joiner (u15) who deletes their account.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(74);

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

-- Back to the database owner, with no signed-in user (so seeding writes no fake author).
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

-- 1. Function security metadata and signature checks
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

-- The app calls supabase.rpc('create_invite', { circleId, role }) and rpc('accept_invite', { token }).
-- PostgREST matches arguments by NAME, so p_circle_id / p_token would make every app call fail.
select is(
  (select array_to_string(p.proargnames, ',') || ':' || pg_get_function_identity_arguments(p.oid)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_invite'),
  'circleId,role:"circleId" uuid, role member_role',
  'create_invite(circleId uuid, role member_role): argument names match the app''s RPC call (spec APIs)'
);

select is(
  (select array_to_string(p.proargnames, ',') || ':' || pg_get_function_identity_arguments(p.oid)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'accept_invite'),
  'token:token text',
  'accept_invite(token text): argument name matches the app''s RPC call (spec APIs)'
);

select is(
  (select bool_and(coalesce(p.proconfig, '{}'::text[]) @> array['search_path=""'])
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('create_invite', 'accept_invite')),
  true,
  'create_invite and accept_invite pin search_path to an empty string'
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

-- Two people accepting the last free seat at the same moment must not both get in. pgTAP runs in one
-- session, so it can only check that accept_invite serializes (a row lock on the circle or the invite,
-- or a transaction advisory lock) before it counts members.
select ok(
  (select p.prosrc ~* '(for\s+update|pg_advisory_xact_lock)'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'accept_invite'),
  'accept_invite locks (for update or pg_advisory_xact_lock) so two joins cannot both take the last seat'
);

-- Seed users u01..u16
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select ('cc1b00' || lpad(n::text, 2, '0') || '-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated',
       'cc1b-user-' || n || '@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()
  from generate_series(1, 16) as n;
-- CC-11 (Claude-approved): seed health-data consent for the inserted test users.
update public.users_profile set health_consent_at = now() where user_id in (select ('cc1b00' || lpad(n::text, 2, '0') || '-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid from generate_series(1, 16) as n);

-- Seed circles (as postgres, no signed-in user)
select pg_temp.as_postgres();
insert into public.circles (id, name, care_recipient_name, timezone, created_by)
values
  ('cc1bc001-0000-4000-8000-000000000001'::uuid, 'Circle A', 'Evelyn', 'Europe/Paris', 'cc1b0001-0000-4000-8000-000000000001'::uuid),
  ('cc1bc002-0000-4000-8000-000000000002'::uuid, 'Circle B', 'Arthur', 'Europe/London', 'cc1b0004-0000-4000-8000-000000000004'::uuid),
  ('cc1bc003-0000-4000-8000-000000000003'::uuid, 'Circle C', 'Rosa', 'Europe/Madrid', 'cc1b0011-0000-4000-8000-000000000011'::uuid),
  ('cc1bc004-0000-4000-8000-000000000004'::uuid, 'Circle D', 'Hugo', 'America/New_York', 'cc1b0014-0000-4000-8000-000000000014'::uuid);

insert into public.circle_members (circle_id, user_id, role)
values
  ('cc1bc001-0000-4000-8000-000000000001'::uuid, 'cc1b0001-0000-4000-8000-000000000001'::uuid, 'owner'),
  ('cc1bc002-0000-4000-8000-000000000002'::uuid, 'cc1b0004-0000-4000-8000-000000000004'::uuid, 'owner'),
  ('cc1bc003-0000-4000-8000-000000000003'::uuid, 'cc1b0011-0000-4000-8000-000000000011'::uuid, 'owner'),
  ('cc1bc003-0000-4000-8000-000000000003'::uuid, 'cc1b0012-0000-4000-8000-000000000012'::uuid, 'helper'),
  ('cc1bc003-0000-4000-8000-000000000003'::uuid, 'cc1b0013-0000-4000-8000-000000000013'::uuid, 'viewer'),
  ('cc1bc003-0000-4000-8000-000000000003'::uuid, 'cc1b0004-0000-4000-8000-000000000004'::uuid, 'helper'),
  ('cc1bc004-0000-4000-8000-000000000004'::uuid, 'cc1b0014-0000-4000-8000-000000000014'::uuid, 'owner');

create temp table tmp_created_invites (
  label text primary key,
  payload jsonb not null
);
grant select, insert, update, delete on table tmp_created_invites to authenticated, service_role;

-- The token inside a saved invite url
create or replace function pg_temp.tok(p_label text)
returns text
language sql
as $$
  select regexp_replace(payload->>'url', '^carecircle://invite/', '')
    from tmp_created_invites where label = p_label
$$;

grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- 2. Direct INSERT into circle_members as authenticated is always refused
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

-- 3. Owner creates invites
select pg_temp.as_user('cc1b0001-0000-4000-8000-000000000001'::uuid);
select throws_ok(
  $$select public.create_invite('cc1bc001-0000-4000-8000-000000000001'::uuid, 'owner'::public.member_role)$$,
  '22023',
  null,
  'create_invite refuses role = owner (a circle has exactly one owner)'
);

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

select is(
  (select role::text || '/' || (used_by is null)::text || '/' || (token = pg_temp.tok('helper_invite_1'))::text
     from public.invites where circle_id = 'cc1bc001-0000-4000-8000-000000000001'::uuid),
  'helper/true/true',
  'the invite row stores the requested role, is unused, and its token is the one in the url'
);

insert into tmp_created_invites (label, payload)
values (
  'viewer_invite_2',
  public.create_invite('cc1bc001-0000-4000-8000-000000000001'::uuid, 'viewer'::public.member_role)
);

select is(
  (select role::text from public.invites where token = pg_temp.tok('viewer_invite_2')),
  'viewer',
  'create_invite stores role = viewer for a viewer invite'
);

select isnt(
  pg_temp.tok('viewer_invite_2'),
  pg_temp.tok('helper_invite_1'),
  'every invite gets its own token'
);

-- 4. Nobody but the owner of that circle creates or reads invites (Circle C)
select pg_temp.as_user('cc1b0011-0000-4000-8000-000000000011'::uuid);
insert into tmp_created_invites (label, payload)
values (
  'circle_c_invite',
  public.create_invite('cc1bc003-0000-4000-8000-000000000003'::uuid, 'helper'::public.member_role)
);

select pg_temp.as_user('cc1b0012-0000-4000-8000-000000000012'::uuid);
select throws_ok(
  $$select public.create_invite('cc1bc003-0000-4000-8000-000000000003'::uuid, 'helper'::public.member_role)$$,
  '42501',
  null,
  'circle helper is refused by create_invite'
);

select is(
  (select count(*)::int from public.invites where circle_id = 'cc1bc003-0000-4000-8000-000000000003'::uuid),
  0,
  'circle helper sees 0 rows and tokens in public.invites'
);

select pg_temp.as_user('cc1b0013-0000-4000-8000-000000000013'::uuid);
select throws_ok(
  $$select public.create_invite('cc1bc003-0000-4000-8000-000000000003'::uuid, 'viewer'::public.member_role)$$,
  '42501',
  null,
  'circle viewer is refused by create_invite'
);

select is(
  (select count(*)::int from public.invites where circle_id = 'cc1bc003-0000-4000-8000-000000000003'::uuid),
  0,
  'circle viewer sees 0 rows and tokens in public.invites'
);

-- Dual-role user: owner of Circle B, but only helper of Circle C
select pg_temp.as_user('cc1b0004-0000-4000-8000-000000000004'::uuid);
select throws_ok(
  $$select public.create_invite('cc1bc003-0000-4000-8000-000000000003'::uuid, 'helper'::public.member_role)$$,
  '42501',
  null,
  'an owner of Circle B who is only a helper of Circle C is refused by create_invite for Circle C'
);

select is(
  (select count(*)::int from public.invites where circle_id = 'cc1bc003-0000-4000-8000-000000000003'::uuid),
  0,
  'an owner of Circle B who is only a helper of Circle C sees 0 rows in public.invites for Circle C'
);

select pg_temp.as_user('cc1b0005-0000-4000-8000-000000000005'::uuid);
select throws_ok(
  $$select public.create_invite('cc1bc003-0000-4000-8000-000000000003'::uuid, 'helper'::public.member_role)$$,
  '42501',
  null,
  'non-member is refused by create_invite'
);

select is(
  (select count(*)::int from public.invites),
  0,
  'non-member sees 0 rows in public.invites'
);

-- The database role "authenticated" but no user id in the token
select pg_temp.as_user('cc1b0005-0000-4000-8000-000000000005'::uuid);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok(
  $$select public.create_invite('cc1bc003-0000-4000-8000-000000000003'::uuid, 'helper'::public.member_role)$$,
  '42501',
  null,
  'create_invite refuses a caller with no user id (null auth.uid())'
);

select pg_temp.as_user('cc1b0011-0000-4000-8000-000000000011'::uuid);
select is(
  (select count(*)::int from public.invites where circle_id = 'cc1bc003-0000-4000-8000-000000000003'::uuid),
  1,
  'refused create_invite calls added no invite rows to Circle C (only the owner''s one)'
);

-- 5. accept_invite: auth.uid() joins, log_entries written as joining user, single-use (INVITE_USED),
--    7-day expiry (INVITE_EXPIRED), and an existing member opening a link (14 checks)
select pg_temp.as_user('cc1b0002-0000-4000-8000-000000000002'::uuid);
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

-- An invite whose 7 days ended a minute ago
select pg_temp.as_postgres();
insert into public.invites (id, circle_id, token, role, expires_at)
values (
  'cc1be001-0000-4000-8000-000000000001'::uuid,
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

-- Accept the valid helper_invite_1 as user u02 (2nd member of Circle A on free plan)
select is(
  (select public.accept_invite(pg_temp.tok('helper_invite_1'))->>'circleId'),
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

select pg_temp.as_postgres();
select is(
  (select used_by from public.invites where token = pg_temp.tok('helper_invite_1')),
  'cc1b0002-0000-4000-8000-000000000002'::uuid,
  'accept_invite marks invites.used_by = auth.uid()'
);

-- Reusing the same invite token as another user fails with INVITE_USED
select pg_temp.as_user('cc1b0003-0000-4000-8000-000000000003'::uuid);
select throws_ok(
  $$select public.accept_invite(pg_temp.tok('helper_invite_1'))$$,
  'P0001',
  'INVITE_USED',
  'accept_invite returns INVITE_USED when an already-used token is reused'
);

-- The person who used it opens the link again: same answer, nothing changes
select pg_temp.as_user('cc1b0002-0000-4000-8000-000000000002'::uuid);
select throws_ok(
  $$select public.accept_invite(pg_temp.tok('helper_invite_1'))$$,
  'P0001',
  'INVITE_USED',
  'accept_invite returns INVITE_USED to the person who already used the token, too'
);

-- The owner opens their own (unused) invite link: they stay owner, and the link stays usable
select pg_temp.as_user('cc1b0001-0000-4000-8000-000000000001'::uuid);
select is(
  (select public.accept_invite(pg_temp.tok('viewer_invite_2'))->>'circleId'),
  'cc1bc001-0000-4000-8000-000000000001',
  'the owner opening their own invite link gets { circleId } back (they are already in the circle)'
);

select pg_temp.as_postgres();
select is(
  (select role::text from public.circle_members
    where circle_id = 'cc1bc001-0000-4000-8000-000000000001'::uuid
      and user_id = 'cc1b0001-0000-4000-8000-000000000001'::uuid),
  'owner',
  'accept_invite never changes the role of someone who is already a member (the owner stays owner)'
);

select is(
  (select (used_by is null and expires_at > now())::text from public.invites where token = pg_temp.tok('viewer_invite_2')),
  'true',
  'an existing member opening a link does not use up the invite'
);

select is(
  (select count(*)::int from public.circle_members where circle_id = 'cc1bc001-0000-4000-8000-000000000001'::uuid)
    || '/' ||
  (select count(*)::int from public.log_entries
    where circle_id = 'cc1bc001-0000-4000-8000-000000000001'::uuid and type = 'member'),
  '2/2',
  'Circle A has exactly 2 members and 2 member log lines (owner and u02) (no extra rows from refused or repeated accepts)'
);

-- 6. Plan limits read from public.entitlements on the server:
--    Free plan max 2 members; active carecircle_family on the circle owner max 8 members (15 checks)
select pg_temp.as_user('cc1b0001-0000-4000-8000-000000000001'::uuid);
insert into tmp_created_invites (label, payload)
values
  ('helper_invite_4', public.create_invite('cc1bc001-0000-4000-8000-000000000001'::uuid, 'helper'::public.member_role)),
  ('helper_invite_5', public.create_invite('cc1bc001-0000-4000-8000-000000000001'::uuid, 'helper'::public.member_role)),
  ('helper_invite_6', public.create_invite('cc1bc001-0000-4000-8000-000000000001'::uuid, 'helper'::public.member_role)),
  ('helper_invite_7', public.create_invite('cc1bc001-0000-4000-8000-000000000001'::uuid, 'helper'::public.member_role)),
  ('helper_invite_8', public.create_invite('cc1bc001-0000-4000-8000-000000000001'::uuid, 'helper'::public.member_role)),
  ('helper_invite_9', public.create_invite('cc1bc001-0000-4000-8000-000000000001'::uuid, 'helper'::public.member_role));

-- Circle A currently has 2 members (owner u01 + helper u02). Free plan limit is 2.
select pg_temp.as_user('cc1b0003-0000-4000-8000-000000000003'::uuid);
select throws_ok(
  $$select public.accept_invite(pg_temp.tok('viewer_invite_2'))$$,
  'P0001',
  'CIRCLE_FULL',
  'free plan circle at 2 members refuses a 3rd member with CIRCLE_FULL'
);

select pg_temp.as_postgres();
select is(
  (select (used_by is null)::text from public.invites where token = pg_temp.tok('viewer_invite_2'))
    || '/' ||
  (select count(*)::int from public.circle_members where circle_id = 'cc1bc001-0000-4000-8000-000000000001'::uuid),
  'true/2',
  'a CIRCLE_FULL refusal adds no member and leaves the invite unused (it works once the owner upgrades)'
);

-- An inactive entitlement (active = false) on the owner does NOT unlock > 2 members
insert into public.entitlements (user_id, entitlement, active, expires_at)
values ('cc1b0001-0000-4000-8000-000000000001'::uuid, 'carecircle_family', false, now() + interval '30 days');

select pg_temp.as_user('cc1b0003-0000-4000-8000-000000000003'::uuid);
select throws_ok(
  $$select public.accept_invite(pg_temp.tok('viewer_invite_2'))$$,
  'P0001',
  'CIRCLE_FULL',
  'inactive carecircle_family entitlement (active = false) still refuses a 3rd member with CIRCLE_FULL'
);

-- An expired entitlement (active = true, expires_at in the past) on the owner does NOT unlock > 2 members
select pg_temp.as_postgres();
update public.entitlements
   set active = true,
       expires_at = now() - interval '1 minute'
 where user_id = 'cc1b0001-0000-4000-8000-000000000001'::uuid
   and entitlement = 'carecircle_family';

select pg_temp.as_user('cc1b0003-0000-4000-8000-000000000003'::uuid);
select throws_ok(
  $$select public.accept_invite(pg_temp.tok('viewer_invite_2'))$$,
  'P0001',
  'CIRCLE_FULL',
  'expired carecircle_family entitlement (expires_at <= now()) still refuses a 3rd member with CIRCLE_FULL'
);

-- An active entitlement with ANOTHER name on the owner does NOT unlock > 2 members
select pg_temp.as_postgres();
delete from public.entitlements;
insert into public.entitlements (user_id, entitlement, active, expires_at)
values ('cc1b0001-0000-4000-8000-000000000001'::uuid, 'some_other_app_pro', true, null);

select pg_temp.as_user('cc1b0003-0000-4000-8000-000000000003'::uuid);
select throws_ok(
  $$select public.accept_invite(pg_temp.tok('viewer_invite_2'))$$,
  'P0001',
  'CIRCLE_FULL',
  'an active entitlement other than carecircle_family on the owner still refuses a 3rd member with CIRCLE_FULL'
);

-- An active entitlement on a NON-OWNER (the helper or the joining user) does NOT unlock > 2 members
select pg_temp.as_postgres();
delete from public.entitlements;
insert into public.entitlements (user_id, entitlement, active, expires_at)
values
  ('cc1b0002-0000-4000-8000-000000000002'::uuid, 'carecircle_family', true, now() + interval '30 days'),
  ('cc1b0003-0000-4000-8000-000000000003'::uuid, 'carecircle_family', true, now() + interval '30 days');

select pg_temp.as_user('cc1b0003-0000-4000-8000-000000000003'::uuid);
select throws_ok(
  $$select public.accept_invite(pg_temp.tok('viewer_invite_2'))$$,
  'P0001',
  'CIRCLE_FULL',
  'entitlement on a helper or joining user does not unlock Circle A when Circle A''s owner is on the free plan'
);

-- Circle A's owner gets an active carecircle_family entitlement that never expires (expires_at null).
-- circles.created_by is cleared first: the plan comes from the circle's OWNER row in circle_members
-- (created_by is null once the creator's account is deleted, and can differ after a transfer).
select pg_temp.as_postgres();
delete from public.entitlements;
insert into public.entitlements (user_id, entitlement, active, expires_at)
values ('cc1b0001-0000-4000-8000-000000000001'::uuid, 'carecircle_family', true, null);
update public.circles set created_by = null where id = 'cc1bc001-0000-4000-8000-000000000001'::uuid;

select pg_temp.as_user('cc1b0003-0000-4000-8000-000000000003'::uuid);
select lives_ok(
  $$select public.accept_invite(pg_temp.tok('viewer_invite_2'))$$,
  'with active carecircle_family on the circle owner, 3rd member (viewer) joins Circle A'
);

select is(
  (select role::text from public.circle_members
    where circle_id = 'cc1bc001-0000-4000-8000-000000000001'::uuid
      and user_id = 'cc1b0003-0000-4000-8000-000000000003'::uuid),
  'viewer',
  'a viewer invite makes the joining user a viewer (the role comes from the invite)'
);

select pg_temp.as_user('cc1b0005-0000-4000-8000-000000000005'::uuid);
select lives_ok(
  $$select public.accept_invite(pg_temp.tok('helper_invite_4'))$$,
  '4th member joins Circle A on Family plan'
);

select pg_temp.as_user('cc1b0006-0000-4000-8000-000000000006'::uuid);
select lives_ok(
  $$select public.accept_invite(pg_temp.tok('helper_invite_5'))$$,
  '5th member joins Circle A on Family plan'
);

select pg_temp.as_user('cc1b0007-0000-4000-8000-000000000007'::uuid);
select lives_ok(
  $$select public.accept_invite(pg_temp.tok('helper_invite_6'))$$,
  '6th member joins Circle A on Family plan'
);

select pg_temp.as_user('cc1b0008-0000-4000-8000-000000000008'::uuid);
select lives_ok(
  $$select public.accept_invite(pg_temp.tok('helper_invite_7'))$$,
  '7th member joins Circle A on Family plan'
);

select pg_temp.as_user('cc1b0009-0000-4000-8000-000000000009'::uuid);
select lives_ok(
  $$select public.accept_invite(pg_temp.tok('helper_invite_8'))$$,
  '8th member joins Circle A on Family plan'
);

select pg_temp.as_user('cc1b0010-0000-4000-8000-000000000010'::uuid);
select throws_ok(
  $$select public.accept_invite(pg_temp.tok('helper_invite_9'))$$,
  'P0001',
  'CIRCLE_FULL',
  'Family plan circle at 8 members refuses a 9th member with CIRCLE_FULL'
);

-- 7. Viewer write restrictions & role management rules
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

-- Helper cannot change member roles or remove other members
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

-- 8. Revoked invites and deleted accounts (Circle D)
select pg_temp.as_user('cc1b0014-0000-4000-8000-000000000014'::uuid);
insert into tmp_created_invites (label, payload)
values
  ('circle_d_used', public.create_invite('cc1bc004-0000-4000-8000-000000000004'::uuid, 'helper'::public.member_role)),
  ('circle_d_revoked', public.create_invite('cc1bc004-0000-4000-8000-000000000004'::uuid, 'helper'::public.member_role));

-- The owner revokes an invite link by deleting its row
delete from public.invites where token = pg_temp.tok('circle_d_revoked');
select is(
  (select count(*)::int from public.invites where circle_id = 'cc1bc004-0000-4000-8000-000000000004'::uuid),
  1,
  'the circle owner can revoke an invite by deleting it'
);

select pg_temp.as_user('cc1b0016-0000-4000-8000-000000000016'::uuid);
select throws_ok(
  $$select public.accept_invite(pg_temp.tok('circle_d_revoked'))$$,
  'P0001',
  'INVITE_INVALID',
  'a revoked invite link is refused with INVITE_INVALID'
);

-- u15 joins Circle D, then deletes their account. invites.used_by is cleared by
-- "on delete set null", but the link must stay used: it was single use.
select pg_temp.as_user('cc1b0015-0000-4000-8000-000000000015'::uuid);
select lives_ok(
  $$select public.accept_invite(pg_temp.tok('circle_d_used'))$$,
  'u15 joins Circle D with an invite'
);

select pg_temp.as_postgres();
delete from auth.users where id = 'cc1b0015-0000-4000-8000-000000000015'::uuid;

select pg_temp.as_user('cc1b0016-0000-4000-8000-000000000016'::uuid);
select throws_matching(
  $$select public.accept_invite(pg_temp.tok('circle_d_used'))$$,
  '^INVITE_(USED|EXPIRED)$',
  'an invite whose user deleted their account cannot be used again (INVITE_USED or INVITE_EXPIRED)'
);

-- 9. Names on the /circle member list. users_profile was "own row only" (F-1); the member
--    list needs the display names of the people in your circles, and nobody else's.
select pg_temp.as_user('cc1b0002-0000-4000-8000-000000000002'::uuid);
select is(
  (select count(*)::int from public.users_profile where user_id = 'cc1b0001-0000-4000-8000-000000000001'::uuid),
  1,
  'a helper can read the users_profile row (display name) of their circle''s owner'
);

select is(
  (select count(*)::int from public.users_profile where user_id = 'cc1b0011-0000-4000-8000-000000000011'::uuid),
  0,
  'a member cannot read the users_profile row of someone who shares no circle with them'
);

select pg_temp.as_user('cc1b0016-0000-4000-8000-000000000016'::uuid);
select is(
  (select count(*)::int from public.users_profile),
  1,
  'someone in no circle reads only their own users_profile row'
);

-- 10. [1-circle rule — separate, clearly named test so it can be flipped once Taha answers]:
--     Until Taha clarifies whether "1 circle" means 1 owned circle or 1 membership in any role,
--     a member of Circle A (u02) can accept an invite to join Circle B as a helper.
select pg_temp.as_user('cc1b0004-0000-4000-8000-000000000004'::uuid);
insert into tmp_created_invites (label, payload)
values (
  'circle_b_helper_invite',
  public.create_invite('cc1bc002-0000-4000-8000-000000000002'::uuid, 'helper'::public.member_role)
);

select pg_temp.as_user('cc1b0002-0000-4000-8000-000000000002'::uuid);
select lives_ok(
  $$select public.accept_invite(pg_temp.tok('circle_b_helper_invite'))$$,
  '[1-circle rule: joining a second circle] a user who belongs to Circle A can accept an invite to join Circle B as helper (flip to throws_ok CIRCLE_LIMIT_REACHED if Taha decides 1 circle caps total memberships)'
);

select * from finish();

rollback;
