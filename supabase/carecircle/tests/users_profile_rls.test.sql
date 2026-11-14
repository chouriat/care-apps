begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(23);

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

-- 1-10: Schema, primary key, foreign key, column types (matching spec), and RLS enabled
select has_table('public', 'users_profile', 'public.users_profile table exists');

select columns_are(
  'public',
  'users_profile',
  array['user_id', 'display_name', 'locale', 'timezone', 'created_at'],
  'users_profile columns match spec character for character'
);

select col_is_pk('public', 'users_profile', 'user_id', 'user_id is the primary key');

select fk_ok(
  'public',
  'users_profile',
  'user_id',
  'auth',
  'users',
  'id',
  'users_profile.user_id references auth.users(id)'
);

select col_type_is('public', 'users_profile', 'user_id', 'uuid', 'user_id is uuid');
select col_type_is('public', 'users_profile', 'display_name', 'text', 'display_name is text');
select col_type_is('public', 'users_profile', 'locale', 'text', 'locale is text');
select col_type_is('public', 'users_profile', 'timezone', 'text', 'timezone is text');
select col_type_is(
  'public',
  'users_profile',
  'created_at',
  'timestamp with time zone',
  'created_at is timestamptz'
);

select is(
  coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.users_profile')), false),
  true,
  'row-level security is enabled on public.users_profile'
);

-- 11: The sign-up trigger function must run as its owner. Supabase Auth inserts into auth.users
-- as supabase_auth_admin, which has no rights on public.users_profile, so a trigger function
-- that is not security definer passes the insert below (run as postgres) but breaks every real
-- sign-up. A security definer function must also pin its search_path.
select ok(
  exists (
    select 1
      from pg_trigger t
      join pg_proc p on p.oid = t.tgfoid
     where t.tgrelid = 'auth.users'::regclass
       and not t.tgisinternal
       and p.prosecdef
       and exists (select 1 from unnest(p.proconfig) as c where c like 'search_path=%')
  ),
  'sign-up trigger function on auth.users is security definer with a fixed search_path'
);

-- 12-13: Sign-up trigger creates users_profile rows automatically when auth.users rows are inserted
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
    '11111111-1111-4111-8111-111111111111'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    'authenticated',
    'authenticated',
    'user-a@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '22222222-2222-4222-8222-222222222222'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    'authenticated',
    'authenticated',
    'user-b@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

select results_eq(
  $$select user_id from public.users_profile
     where user_id in (
       '11111111-1111-4111-8111-111111111111'::uuid,
       '22222222-2222-4222-8222-222222222222'::uuid
     )
     order by user_id$$,
  array[
    '11111111-1111-4111-8111-111111111111'::uuid,
    '22222222-2222-4222-8222-222222222222'::uuid
  ],
  'sign-up trigger on auth.users creates users_profile rows automatically'
);

select isnt(
  (select created_at from public.users_profile where user_id = '11111111-1111-4111-8111-111111111111'::uuid),
  null,
  'sign-up trigger populates created_at'
);

-- Seed baseline display_name for user B as postgres to test cross-user update isolation
update public.users_profile
   set display_name = 'User B',
       locale = 'en',
       timezone = 'America/New_York'
 where user_id = '22222222-2222-4222-8222-222222222222'::uuid;

-- 14: Unauthenticated (anon) cannot read any rows. Either RLS returns 0 rows or the table is not
-- granted to anon at all (permission denied); both are acceptable, so the read runs through a
-- helper that counts a permission error as 0 visible rows instead of aborting the suite.
create function pg_temp.visible_users_profile_rows() returns integer
language plpgsql
as $$
declare
  n integer;
begin
  execute 'select count(*)::int from public.users_profile' into n;
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
  pg_temp.visible_users_profile_rows(),
  0,
  'anon role reads 0 rows from users_profile'
);

-- 15-17: User A can read own row and cannot read user B row
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);

select results_eq(
  $$select user_id from public.users_profile where user_id = '11111111-1111-4111-8111-111111111111'::uuid$$,
  array['11111111-1111-4111-8111-111111111111'::uuid],
  'user A can read their own users_profile row'
);

select is_empty(
  $$select user_id from public.users_profile where user_id = '22222222-2222-4222-8222-222222222222'::uuid$$,
  'user A cannot read user B users_profile row'
);

select results_eq(
  $$select user_id from public.users_profile$$,
  array['11111111-1111-4111-8111-111111111111'::uuid],
  'unfiltered select as user A returns only user A row'
);

-- 18: User B sees only user B row
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}',
  true
);

select results_eq(
  $$select user_id from public.users_profile$$,
  array['22222222-2222-4222-8222-222222222222'::uuid],
  'unfiltered select as user B returns only user B row'
);

-- 19-23: Switch back to user A and verify write isolation (own update allowed; cross-user update/insert/delete refused)
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);

update public.users_profile
   set display_name = 'User A',
       locale = 'en',
       timezone = 'Europe/Berlin'
 where user_id = '11111111-1111-4111-8111-111111111111'::uuid;

select results_eq(
  $$select display_name, locale, timezone
      from public.users_profile
     where user_id = '11111111-1111-4111-8111-111111111111'::uuid$$,
  $$values ('User A'::text, 'en'::text, 'Europe/Berlin'::text)$$,
  'user A can update their own users_profile row'
);

update public.users_profile
   set display_name = 'Tampered'
 where user_id = '22222222-2222-4222-8222-222222222222'::uuid;

set local role postgres;

select is(
  (select display_name from public.users_profile where user_id = '22222222-2222-4222-8222-222222222222'::uuid),
  'User B',
  'user A cannot update user B users_profile row'
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);

select throws_ok(
  $$update public.users_profile
       set user_id = '99999999-9999-4999-8999-999999999999'::uuid
     where user_id = '11111111-1111-4111-8111-111111111111'::uuid$$,
  '42501',
  null,
  'user A cannot reassign their users_profile row to another user_id'
);

select throws_ok(
  $$insert into public.users_profile (user_id, display_name, locale, timezone)
    values ('99999999-9999-4999-8999-999999999999'::uuid, 'Spoofed', 'en', 'UTC')$$,
  '42501',
  null,
  'user A cannot insert a users_profile row for another user'
);

do $$
begin
  delete from public.users_profile
   where user_id in (
     '11111111-1111-4111-8111-111111111111'::uuid,
     '22222222-2222-4222-8222-222222222222'::uuid
   );
exception
  when insufficient_privilege then
    null;
end;
$$;

set local role postgres;

select is(
  (
    select count(*)::int
      from public.users_profile
     where user_id in (
       '11111111-1111-4111-8111-111111111111'::uuid,
       '22222222-2222-4222-8222-222222222222'::uuid
     )
  ),
  2,
  'user A cannot delete own or user B users_profile row'
);

select * from finish();

rollback;
