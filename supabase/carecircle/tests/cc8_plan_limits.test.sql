-- CC-8 [safety 1/2]: Server-side Family plan limit tests (`supabase/carecircle/tests/cc8_plan_limits.test.sql`).
--
-- Verifies that every free-plan and Family-plan limit is enforced by the database even when called
-- directly by a modified app (bypassing client UI checks):
-- 1. Members limit:
--    - Free circle (2 members): `accept_invite` by a 3rd user raises `CIRCLE_FULL`, `create_invite`
--      by the owner of an already-full free circle (2 members) raises `CIRCLE_FULL`, and direct
--      `INSERT INTO public.circle_members` by the owner or by the invitee is refused by RLS/privileges (`42501`).
--    - Expired entitlement (`active = true`, `expires_at` in the past) counts as Free (2 members max;
--      3rd member refused with `CIRCLE_FULL`).
--    - Family circle (`active = true`, `expires_at` in the future): up to 8 members allowed; 9th
--      member refused by `accept_invite` (`CIRCLE_FULL`), by `create_invite` (`CIRCLE_FULL`), and by
--      direct `INSERT INTO public.circle_members` (`42501`).
-- 2. Circles limit ("1 circle you own", per Taha's decision on 2026-11-17):
--    - A user's second `public.create_circle` is refused with `CIRCLE_LIMIT_REACHED` (and direct `INSERT`
--      into `public.circles` is refused with `42501`).
--    - Separate, clearly named test section `[1-CIRCLE-JOIN-HELPER-OR-VIEWER]` proving that a user
--      who already owns 1 circle can still join another family's circle as `helper` or `viewer`
--      via `public.accept_invite`, and a helper in another circle who owns 0 circles can create
--      their 1st owned circle (but not a 2nd).
-- 3. Self-write protection on `public.entitlements`:
--    - Already covered in `supabase/carecircle/tests/entitlements_rls.test.sql` (lines 62-70 and
--      169-198: `anon` and `authenticated` cannot INSERT, UPDATE, or DELETE rows in
--      `public.entitlements`; only `service_role` can). Referenced here without duplication.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(25);

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

create or replace function pg_temp.extract_token(p_invite jsonb)
returns text
language sql
immutable
as $$
  select regexp_replace(p_invite->>'url', '^carecircle://invite/', '');
$$;

-- Seed test users
select pg_temp.as_postgres();

insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select
  ('cc800000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  '00000000-0000-0000-0000-000000000000'::uuid,
  'authenticated',
  'authenticated',
  'cc8-user-' || i::text || '@example.test',
  '{}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
from generate_series(1, 15) as g(i);
-- CC-11 (Claude-approved): seed health-data consent for the inserted test users.
update public.users_profile set health_consent_at = now() where user_id in (select ('cc800000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid from generate_series(1, 15) as g(i));

create temp table tmp_cc8 (
  key text primary key,
  circle_id uuid,
  token text
);

grant select, insert, update, delete on table tmp_cc8 to authenticated;

-- ============================================================================
-- Section 1: Free circle member limit (max 2) + "modified app" direct INSERT
-- ============================================================================

-- User 1 creates a Free circle (1st member = owner)
select pg_temp.as_user('cc800000-0000-4000-8000-000000000001'::uuid);
insert into tmp_cc8 (key, circle_id)
values (
  'free_circle',
  (public.create_circle('Free Family Circle', 'Evelyn', 'America/New_York')).id
);

-- Owner creates two invites while the circle has 1 member
insert into tmp_cc8 (key, circle_id, token)
select
  'free_inv_1',
  circle_id,
  pg_temp.extract_token(public.create_invite(circle_id, 'helper'::public.member_role))
from tmp_cc8 where key = 'free_circle';

insert into tmp_cc8 (key, circle_id, token)
select
  'free_inv_2',
  circle_id,
  pg_temp.extract_token(public.create_invite(circle_id, 'viewer'::public.member_role))
from tmp_cc8 where key = 'free_circle';

-- User 2 accepts first invite -> circle now has 2 members (at Free plan cap)
select pg_temp.as_user('cc800000-0000-4000-8000-000000000002'::uuid);
select lives_ok(
  $$select public.accept_invite((select token from tmp_cc8 where key = 'free_inv_1'))$$,
  '2nd member joins free circle via accept_invite'
);

-- User 3 attempts to accept second invite into the 2-member free circle -> refused with CIRCLE_FULL
select pg_temp.as_user('cc800000-0000-4000-8000-000000000003'::uuid);
select throws_ok(
  $$select public.accept_invite((select token from tmp_cc8 where key = 'free_inv_2'))$$,
  'P0001',
  'CIRCLE_FULL',
  'free circle with 2 members refuses 3rd member in accept_invite with CIRCLE_FULL'
);

-- Claude's review: the owner of a full free circle MAY still create an invite. The approved CC-1b
-- tests require it (cc1b_invites_and_roles.test.sql: "it works once the owner upgrades"); the limit
-- is enforced when someone tries to join (accept_invite above). So this checks the opposite of the
-- original [safety 1/2] line.
select pg_temp.as_user('cc800000-0000-4000-8000-000000000001'::uuid);
select lives_ok(
  $$select public.create_invite((select circle_id from tmp_cc8 where key = 'free_circle'), 'helper'::public.member_role)$$,
  'owner of a full 2-member free circle can still create an invite (it only works after an upgrade)'
);

-- Modified app angle 1a: Owner directly INSERTs 3rd member into circle_members -> refused by RLS/privileges
select pg_temp.as_user('cc800000-0000-4000-8000-000000000001'::uuid);
select throws_ok(
  $$insert into public.circle_members (circle_id, user_id, role)
    values (
      (select circle_id from tmp_cc8 where key = 'free_circle'),
      'cc800000-0000-4000-8000-000000000003'::uuid,
      'helper'::public.member_role
    )$$,
  '42501',
  null,
  'modified app: owner direct INSERT into circle_members is refused by RLS/privileges (42501)'
);

-- Modified app angle 1b: Invitee directly INSERTs themselves into circle_members -> refused by RLS/privileges
select pg_temp.as_user('cc800000-0000-4000-8000-000000000003'::uuid);
select throws_ok(
  $$insert into public.circle_members (circle_id, user_id, role)
    values (
      (select circle_id from tmp_cc8 where key = 'free_circle'),
      'cc800000-0000-4000-8000-000000000003'::uuid,
      'viewer'::public.member_role
    )$$,
  '42501',
  null,
  'modified app: invitee direct INSERT into circle_members is refused by RLS/privileges (42501)'
);

select pg_temp.as_postgres();
select is(
  (select count(*)::int from public.circle_members where circle_id = (select circle_id from tmp_cc8 where key = 'free_circle')),
  2,
  'free circle remains at exactly 2 members after all rejected join and direct insert attempts'
);

-- ============================================================================
-- Section 2: Expired entitlement (`active = true`, `expires_at` in the past)
-- ============================================================================

select pg_temp.as_postgres();
insert into public.entitlements (user_id, entitlement, active, expires_at)
values (
  'cc800000-0000-4000-8000-000000000001'::uuid,
  'carecircle_family',
  true,
  now() - interval '1 hour'
);

select pg_temp.as_user('cc800000-0000-4000-8000-000000000003'::uuid);
select throws_ok(
  $$select public.accept_invite((select token from tmp_cc8 where key = 'free_inv_2'))$$,
  'P0001',
  'CIRCLE_FULL',
  'expired entitlement (active = true, expires_at in the past) counts as free and refuses 3rd member with CIRCLE_FULL'
);

-- ============================================================================
-- Section 3: Family circle member limit (up to 8, 9th refused)
-- ============================================================================

select pg_temp.as_postgres();
update public.entitlements
   set active = true,
       expires_at = now() + interval '30 days'
 where user_id = 'cc800000-0000-4000-8000-000000000001'::uuid
   and entitlement = 'carecircle_family';

-- Owner creates invites for members 3..9
select pg_temp.as_user('cc800000-0000-4000-8000-000000000001'::uuid);
insert into tmp_cc8 (key, circle_id, token)
select
  'fam_inv_' || i::text,
  (select circle_id from tmp_cc8 where key = 'free_circle'),
  pg_temp.extract_token(
    public.create_invite(
      (select circle_id from tmp_cc8 where key = 'free_circle'),
      'helper'::public.member_role
    )
  )
from generate_series(3, 9) as g(i);

-- Members 3 through 8 join successfully on Family plan
select pg_temp.as_user('cc800000-0000-4000-8000-000000000003'::uuid);
select lives_ok(
  $$select public.accept_invite((select token from tmp_cc8 where key = 'fam_inv_3'))$$,
  'Family circle allows 3rd member'
);

select pg_temp.as_user('cc800000-0000-4000-8000-000000000004'::uuid);
select lives_ok(
  $$select public.accept_invite((select token from tmp_cc8 where key = 'fam_inv_4'))$$,
  'Family circle allows 4th member'
);

select pg_temp.as_user('cc800000-0000-4000-8000-000000000005'::uuid);
select lives_ok(
  $$select public.accept_invite((select token from tmp_cc8 where key = 'fam_inv_5'))$$,
  'Family circle allows 5th member'
);

select pg_temp.as_user('cc800000-0000-4000-8000-000000000006'::uuid);
select lives_ok(
  $$select public.accept_invite((select token from tmp_cc8 where key = 'fam_inv_6'))$$,
  'Family circle allows 6th member'
);

select pg_temp.as_user('cc800000-0000-4000-8000-000000000007'::uuid);
select lives_ok(
  $$select public.accept_invite((select token from tmp_cc8 where key = 'fam_inv_7'))$$,
  'Family circle allows 7th member'
);

select pg_temp.as_user('cc800000-0000-4000-8000-000000000008'::uuid);
select lives_ok(
  $$select public.accept_invite((select token from tmp_cc8 where key = 'fam_inv_8'))$$,
  'Family circle allows 8th member'
);

-- 9th member is refused with CIRCLE_FULL
select pg_temp.as_user('cc800000-0000-4000-8000-000000000009'::uuid);
select throws_ok(
  $$select public.accept_invite((select token from tmp_cc8 where key = 'fam_inv_9'))$$,
  'P0001',
  'CIRCLE_FULL',
  'Family circle at 8 members refuses 9th member in accept_invite with CIRCLE_FULL'
);

-- Owner of an 8-member Family circle attempting create_invite is refused with CIRCLE_FULL
-- (Expected to fail until CC-8 [safety 2/2] adds the member-count check to create_invite)
select pg_temp.as_user('cc800000-0000-4000-8000-000000000001'::uuid);
select throws_ok(
  $$select public.create_invite((select circle_id from tmp_cc8 where key = 'free_circle'), 'viewer'::public.member_role)$$,
  'P0001',
  'CIRCLE_FULL',
  'owner of a full 8-member Family circle is refused by create_invite with CIRCLE_FULL'
);

-- Modified app angle: Family owner directly INSERTs 9th member -> refused by RLS/privileges
select throws_ok(
  $$insert into public.circle_members (circle_id, user_id, role)
    values (
      (select circle_id from tmp_cc8 where key = 'free_circle'),
      'cc800000-0000-4000-8000-000000000009'::uuid,
      'viewer'::public.member_role
    )$$,
  '42501',
  null,
  'modified app: Family owner direct INSERT of 9th member into circle_members is refused (42501)'
);

select pg_temp.as_postgres();
select is(
  (select count(*)::int from public.circle_members where circle_id = (select circle_id from tmp_cc8 where key = 'free_circle')),
  8,
  'Family circle remains at 8 members after 9th member refusal'
);

-- ============================================================================
-- Section 4: "1 circle" rule ("one circle you own", per Taha's decision)
-- ============================================================================

-- Free user (User 10) creates their 1st circle -> allowed
select pg_temp.as_user('cc800000-0000-4000-8000-000000000010'::uuid);
insert into tmp_cc8 (key, circle_id)
values (
  'u10_circle_1',
  (public.create_circle('User 10 Circle 1', 'Arthur', 'Europe/London')).id
);

select is(
  (select count(*)::int from public.circle_members
    where user_id = 'cc800000-0000-4000-8000-000000000010'::uuid
      and role = 'owner'::public.member_role),
  1,
  'User 10 owns 1 circle after first create_circle'
);

-- User 10 calls create_circle a second time -> refused with CIRCLE_LIMIT_REACHED
-- (Claude's review: the error stays CIRCLE_LIMIT_REACHED, the name create_circle and the app have used since CC-1a/CC-1b)
select throws_ok(
  $$select public.create_circle('User 10 Circle 2', 'Beatrice', 'Europe/London')$$,
  'P0001',
  'CIRCLE_LIMIT_REACHED',
  'free user second create_circle is refused with CIRCLE_LIMIT_REACHED'
);

-- Modified app angle: User 10 directly INSERTs a second row into public.circles -> refused (42501)
select throws_ok(
  $$insert into public.circles (name, care_recipient_name, timezone, created_by)
    values ('Bypass Circle', 'Beatrice', 'Europe/London', 'cc800000-0000-4000-8000-000000000010'::uuid)$$,
  '42501',
  null,
  'modified app: direct INSERT into public.circles is refused by RLS/privileges (42501)'
);

-- Even a Family-plan owner is capped at 1 owned circle (spec: "carecircle_family: 1 circle, up to 8 members")
select pg_temp.as_user('cc800000-0000-4000-8000-000000000001'::uuid);
select throws_ok(
  $$select public.create_circle('Family Owner Second Circle', 'Charles', 'America/New_York')$$,
  'P0001',
  'CIRCLE_LIMIT_REACHED',
  'Family plan owner second create_circle is also refused with CIRCLE_LIMIT_REACHED'
);

-- ============================================================================
-- Section 5: [1-CIRCLE-JOIN-HELPER-OR-VIEWER] (separate clearly named tests)
-- Taha decided (2026-11-17): "It is one circle I own" — joining another
-- family's circle as helper or viewer is allowed even if you already own a circle,
-- and being a helper/viewer in another circle does not block creating your 1st owned circle.
-- ============================================================================

-- User 11 creates Circle B and invites User 10 (who already owns u10_circle_1) as helper
select pg_temp.as_user('cc800000-0000-4000-8000-000000000011'::uuid);
insert into tmp_cc8 (key, circle_id)
values (
  'u11_circle',
  (public.create_circle('User 11 Circle', 'Diana', 'Europe/Paris')).id
);

insert into tmp_cc8 (key, circle_id, token)
select
  'u11_helper_inv',
  circle_id,
  pg_temp.extract_token(public.create_invite(circle_id, 'helper'::public.member_role))
from tmp_cc8 where key = 'u11_circle';

-- User 12 creates Circle C and invites User 10 as viewer
select pg_temp.as_user('cc800000-0000-4000-8000-000000000012'::uuid);
insert into tmp_cc8 (key, circle_id)
values (
  'u12_circle',
  (public.create_circle('User 12 Circle', 'Edward', 'Europe/Paris')).id
);

insert into tmp_cc8 (key, circle_id, token)
select
  'u12_viewer_inv',
  circle_id,
  pg_temp.extract_token(public.create_invite(circle_id, 'viewer'::public.member_role))
from tmp_cc8 where key = 'u12_circle';

-- [1-CIRCLE-JOIN-HELPER-OR-VIEWER] User 10 (owns 1 circle) joins Circle B as helper -> allowed
select pg_temp.as_user('cc800000-0000-4000-8000-000000000010'::uuid);
select lives_ok(
  $$select public.accept_invite((select token from tmp_cc8 where key = 'u11_helper_inv'))$$,
  '[1-CIRCLE-JOIN-HELPER-OR-VIEWER] owner of 1 circle can join another family''s circle as helper'
);

-- [1-CIRCLE-JOIN-HELPER-OR-VIEWER] User 10 (owns 1 circle, helper in 1) joins Circle C as viewer -> allowed
select lives_ok(
  $$select public.accept_invite((select token from tmp_cc8 where key = 'u12_viewer_inv'))$$,
  '[1-CIRCLE-JOIN-HELPER-OR-VIEWER] owner of 1 circle can join a third family''s circle as viewer'
);

-- [1-CIRCLE-JOIN-HELPER-OR-VIEWER] User 2 (helper in free_circle, owns 0 circles) can create their 1st owned circle
select pg_temp.as_user('cc800000-0000-4000-8000-000000000002'::uuid);
select lives_ok(
  $$select public.create_circle('User 2 Own Circle', 'Florence', 'America/New_York')$$,
  '[1-CIRCLE-JOIN-HELPER-OR-VIEWER] helper in another circle who owns 0 circles can create their 1st owned circle'
);

-- And User 2's 2nd owned circle is refused with CIRCLE_LIMIT_REACHED
select throws_ok(
  $$select public.create_circle('User 2 Second Own Circle', 'George', 'America/New_York')$$,
  'P0001',
  'CIRCLE_LIMIT_REACHED',
  '[1-CIRCLE-JOIN-HELPER-OR-VIEWER] helper who now owns 1 circle is refused a 2nd owned circle with CIRCLE_LIMIT_REACHED'
);

select * from finish();

rollback;
