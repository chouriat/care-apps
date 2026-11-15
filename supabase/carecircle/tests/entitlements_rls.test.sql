begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(24);

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

-- 1-8: Schema, PK, FK, column types, and RLS enabled (Spec Part 1 > Entitlements)
select has_table('public', 'entitlements', 'public.entitlements table exists');

select columns_are(
  'public',
  'entitlements',
  array['user_id', 'entitlement', 'active', 'expires_at'],
  'entitlements columns match spec (user_id, entitlement, active, expires_at)'
);

select col_is_pk(
  'public',
  'entitlements',
  array['user_id', 'entitlement'],
  '(user_id, entitlement) is the composite primary key'
);

select fk_ok(
  'public',
  'entitlements',
  'user_id',
  'auth',
  'users',
  'id',
  'entitlements.user_id references auth.users(id)'
);

select col_type_is('public', 'entitlements', 'user_id', 'uuid', 'user_id is uuid');
select col_type_is('public', 'entitlements', 'entitlement', 'text', 'entitlement is text');
select col_type_is('public', 'entitlements', 'active', 'boolean', 'active is boolean');
select col_type_is(
  'public',
  'entitlements',
  'expires_at',
  'timestamp with time zone',
  'expires_at is timestamptz'
);

-- A missing value must never read as "maybe paid": active is required and starts false.
select col_not_null('public', 'entitlements', 'active', 'active is not null');
select col_default_is('public', 'entitlements', 'active', 'false', 'active defaults to false');

-- Table privileges: the app may only read; anon gets nothing; the webhook (service_role) writes.
select table_privs_are(
  'public', 'entitlements', 'anon', array[]::text[],
  'anon has no privileges on entitlements'
);
select table_privs_are(
  'public', 'entitlements', 'authenticated', array['SELECT'],
  'authenticated may only SELECT entitlements'
);

-- 9: RLS enabled
select is(
  coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.entitlements')), false),
  true,
  'row-level security is enabled on public.entitlements'
);

-- Seed two users and one active entitlement via service_role/postgres
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
    'aaaaaaaa-1111-4111-8111-111111111111'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    'authenticated',
    'authenticated',
    'paywall-a@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    'bbbbbbbb-2222-4222-8222-222222222222'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    'authenticated',
    'authenticated',
    'paywall-b@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into public.entitlements (user_id, entitlement, active, expires_at)
values
  ('aaaaaaaa-1111-4111-8111-111111111111'::uuid, 'carecircle_family', false, null),
  ('bbbbbbbb-2222-4222-8222-222222222222'::uuid, 'carecircle_family', true, now() + interval '30 days');

-- 10: anon reads 0 rows
create function pg_temp.visible_entitlement_rows() returns integer
language plpgsql
as $$
declare
  n integer;
begin
  execute 'select count(*)::int from public.entitlements' into n;
  return n;
exception
  when insufficient_privilege then
    return 0;
end;
$$;

set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{"role":"anon"}', true);

select is(
  pg_temp.visible_entitlement_rows(),
  0,
  'anon role reads 0 rows from entitlements'
);

-- 11-16: User A can read only own row and CANNOT insert, update, or delete entitlements
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'aaaaaaaa-1111-4111-8111-111111111111', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"aaaaaaaa-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);

select is_empty(
  $$select entitlement from public.entitlements where user_id = 'bbbbbbbb-2222-4222-8222-222222222222'::uuid$$,
  'user A cannot read user B entitlements'
);

select results_eq(
  $$select entitlement, active from public.entitlements$$,
  $$values ('carecircle_family'::text, false)$$,
  'user A reads only their own entitlement row'
);

select throws_ok(
  $$insert into public.entitlements (user_id, entitlement, active)
    values ('aaaaaaaa-1111-4111-8111-111111111111'::uuid, 'carecircle_family', true)$$,
  '42501',
  null,
  'authenticated client cannot self-insert entitlements (only webhook service_role can)'
);

select throws_ok(
  $$update public.entitlements set active = true
     where user_id = 'aaaaaaaa-1111-4111-8111-111111111111'::uuid$$,
  '42501',
  null,
  'authenticated client cannot self-upgrade active=true on entitlements'
);

select throws_ok(
  $$delete from public.entitlements
     where user_id = 'aaaaaaaa-1111-4111-8111-111111111111'::uuid$$,
  '42501',
  null,
  'authenticated client cannot delete rows from entitlements'
);

set local role postgres;
select is(
  (select active from public.entitlements where user_id = 'aaaaaaaa-1111-4111-8111-111111111111'::uuid),
  false,
  'user A entitlement remains false after rejected client write attempts'
);

-- The RevenueCat webhook writes with the service role: insert, update (upsert) and delete must work.
set local role service_role;
select lives_ok(
  $$insert into public.entitlements (user_id, entitlement, active, expires_at)
    values ('aaaaaaaa-1111-4111-8111-111111111111'::uuid, 'carecircle_family', true, now() + interval '30 days')
    on conflict (user_id, entitlement) do update
      set active = excluded.active, expires_at = excluded.expires_at$$,
  'service_role can upsert an entitlement (webhook)'
);
select is(
  (select active from public.entitlements where user_id = 'aaaaaaaa-1111-4111-8111-111111111111'::uuid),
  true,
  'service_role upsert changed the row'
);
select lives_ok(
  $$delete from public.entitlements where user_id = 'aaaaaaaa-1111-4111-8111-111111111111'::uuid$$,
  'service_role can delete an entitlement'
);
set local role postgres;

-- 17: Cascade delete on auth.users deletion
delete from auth.users where id = 'bbbbbbbb-2222-4222-8222-222222222222'::uuid;

select is(
  (select count(*)::int from public.entitlements where user_id = 'bbbbbbbb-2222-4222-8222-222222222222'::uuid),
  0,
  'deleting auth.users row cascades to entitlements'
);

select * from finish();

rollback;
