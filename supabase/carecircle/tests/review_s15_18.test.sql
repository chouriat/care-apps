-- Claude's combined review of batch/s15-18 (20 Nov 2026): tests for the fixes in
-- migrations/20261120000001_review_s15_18.sql.
-- 1. circle_has_family_plan cannot be called by signed-in users (only inside accept_invite and by the service role).
-- 2. transfer_ownership cannot give someone a second owned circle (the 1-circle rule).
-- 3. delete_own_account leaves the Storage rows for the delete-account Edge Function, which deletes
--    the files through the Storage API (a SQL delete leaves the files behind).
-- 4. Only the service role (or a database session) may name another user to delete_own_account.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(9);

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

grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

select pg_temp.as_postgres();

-- r1 owns Family circle F (r2 helper in it); r3 owns their own circle G; r4 is a stranger;
-- r5 owns solo circle S.
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select
  ('5a180000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  '00000000-0000-0000-0000-000000000000'::uuid,
  'authenticated',
  'authenticated',
  'review-s15-18-' || i::text || '@example.test',
  '{}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
from generate_series(1, 5) as g(i);
-- CC-11 (Claude-approved): seed health-data consent for the inserted test users.
update public.users_profile set health_consent_at = now() where user_id in (select ('5a180000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid from generate_series(1, 5) as g(i));

insert into public.entitlements (user_id, entitlement, active, expires_at)
values ('5a180000-0000-4000-8000-000000000001'::uuid, 'carecircle_family', true, now() + interval '30 days');

create temp table tmp_r (key text primary key, id uuid);
grant select, insert, update, delete on table tmp_r to authenticated, service_role;

select pg_temp.as_user('5a180000-0000-4000-8000-000000000001'::uuid);
insert into tmp_r values ('F', (public.create_circle('Family F', 'Grandma F', 'Europe/Berlin')).id);

select pg_temp.as_postgres();
insert into public.circle_members (circle_id, user_id, role)
select id, '5a180000-0000-4000-8000-000000000002'::uuid, 'helper'::public.member_role
  from tmp_r where key = 'F';
insert into public.circle_members (circle_id, user_id, role)
select id, '5a180000-0000-4000-8000-000000000003'::uuid, 'viewer'::public.member_role
  from tmp_r where key = 'F';

select pg_temp.as_user('5a180000-0000-4000-8000-000000000003'::uuid);
insert into tmp_r values ('G', (public.create_circle('Family G', 'Grandpa G', 'Europe/Berlin')).id);

select pg_temp.as_user('5a180000-0000-4000-8000-000000000005'::uuid);
insert into tmp_r values ('S', (public.create_circle('Solo S', 'Aunt S', 'Europe/Berlin')).id);

-- 1. circle_has_family_plan: signed-in users cannot call it at all (not even members)
select pg_temp.as_user('5a180000-0000-4000-8000-000000000004'::uuid);
select throws_ok(
  $$select public.circle_has_family_plan((select id from tmp_r where key = 'F'))$$,
  '42501',
  null,
  'a signed-in stranger cannot ask whether another family pays'
);

select pg_temp.as_user('5a180000-0000-4000-8000-000000000002'::uuid);
select throws_ok(
  $$select public.circle_has_family_plan((select id from tmp_r where key = 'F'))$$,
  '42501',
  null,
  'a member cannot call it directly either (only accept_invite and the service role use it)'
);

-- 2. transfer_ownership and the 1-circle rule
select pg_temp.as_user('5a180000-0000-4000-8000-000000000001'::uuid);
select throws_ok(
  $$select public.transfer_ownership(
      (select id from tmp_r where key = 'F'),
      '5a180000-0000-4000-8000-000000000003'::uuid
    )$$,
  'P0001',
  'CIRCLE_LIMIT_REACHED',
  'ownership cannot go to a member who already owns another circle'
);

select is(
  (select role::text from public.circle_members
    where circle_id = (select id from tmp_r where key = 'F')
      and user_id = '5a180000-0000-4000-8000-000000000001'::uuid),
  'owner',
  'after the refused transfer the old owner is still the owner'
);

select lives_ok(
  $$select public.transfer_ownership(
      (select id from tmp_r where key = 'F'),
      '5a180000-0000-4000-8000-000000000002'::uuid
    )$$,
  'ownership can go to a member who owns no circle'
);

-- 3. delete_own_account keeps the Storage rows for the Edge Function
select pg_temp.as_postgres();
insert into storage.objects (id, bucket_id, name, owner, metadata)
select
  '5a18f001-0000-4000-8000-000000000001'::uuid,
  'visit-audio',
  id::text || '/11111111-1111-4111-8111-111111111111.m4a',
  '5a180000-0000-4000-8000-000000000005'::uuid,
  '{"mimetype":"audio/m4a","size":1000}'::jsonb
from tmp_r where key = 'S';

-- 4. Only the service role may name another user
select pg_temp.as_user('5a180000-0000-4000-8000-000000000004'::uuid);
select throws_ok(
  $$select public.delete_own_account('5a180000-0000-4000-8000-000000000005'::uuid)$$,
  '42501',
  null,
  'a signed-in user cannot delete someone else''s account'
);

select pg_temp.as_postgres();
select lives_ok(
  $$select public.delete_own_account('5a180000-0000-4000-8000-000000000005'::uuid)$$,
  'a database session (like the service role) can delete a named account'
);

select is(
  (select count(*)::int from public.circles where id = (select id from tmp_r where key = 'S')),
  0,
  'the solo owner''s circle is gone'
);

select is(
  (select count(*)::int from storage.objects where id = '5a18f001-0000-4000-8000-000000000001'::uuid),
  1,
  'its Storage row is left for the Edge Function to delete the file through the Storage API'
);

select * from finish();
rollback;
