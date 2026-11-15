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

-- 1-8: Schema, PK, FK, column types, and RLS enabled
select has_table('public', 'push_tokens', 'public.push_tokens table exists');

select columns_are(
  'public',
  'push_tokens',
  array['user_id', 'token', 'platform', 'updated_at'],
  'push_tokens columns match spec (user_id, token, platform, updated_at)'
);

select col_is_pk(
  'public',
  'push_tokens',
  'token',
  'token is the primary key: one phone belongs to one user at a time'
);

select fk_ok(
  'public',
  'push_tokens',
  'user_id',
  'auth',
  'users',
  'id',
  'push_tokens.user_id references auth.users(id)'
);

select col_type_is('public', 'push_tokens', 'user_id', 'uuid', 'user_id is uuid');
select col_type_is('public', 'push_tokens', 'token', 'text', 'token is text');
select col_type_is('public', 'push_tokens', 'platform', 'text', 'platform is text');
select col_type_is(
  'public',
  'push_tokens',
  'updated_at',
  'timestamp with time zone',
  'updated_at is timestamptz'
);

-- 9: RLS enabled
select is(
  coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.push_tokens')), false),
  true,
  'row-level security is enabled on public.push_tokens'
);

-- Seed two users in auth.users
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
    'push-a@example.test',
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
    'push-b@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into public.push_tokens (user_id, token, platform)
values ('bbbbbbbb-2222-4222-8222-222222222222'::uuid, 'ExponentPushToken[user-b-token]', 'android');

-- 10: anon cannot read push_tokens
create function pg_temp.visible_push_token_rows() returns integer
language plpgsql
as $$
declare
  n integer;
begin
  execute 'select count(*)::int from public.push_tokens' into n;
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
  pg_temp.visible_push_token_rows(),
  0,
  'anon role reads 0 rows from push_tokens'
);

-- 11: anon cannot register a token
select throws_ok(
  $$select public.register_push_token('ExponentPushToken[anon-token]', 'ios')$$,
  '42501',
  null,
  'anon cannot call register_push_token'
);

-- 12-26: User A isolation, registration and constraints
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'aaaaaaaa-1111-4111-8111-111111111111', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"aaaaaaaa-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);

select is_empty(
  $$select token from public.push_tokens where user_id = 'bbbbbbbb-2222-4222-8222-222222222222'::uuid$$,
  'user A cannot read user B push tokens'
);

select throws_ok(
  $$insert into public.push_tokens (user_id, token, platform)
    values ('aaaaaaaa-1111-4111-8111-111111111111'::uuid, 'ExponentPushToken[direct]', 'ios')$$,
  '42501',
  null,
  'direct inserts are closed; registration goes through register_push_token'
);

select lives_ok(
  $$select public.register_push_token('ExponentPushToken[user-a-token]', 'ios')$$,
  'user A can register their own push token'
);

select lives_ok(
  $$select public.register_push_token('ExponentPushToken[user-a-token]', 'android')$$,
  'registering the same token again (app restart) updates it instead of failing'
);

select results_eq(
  $$select token, platform, user_id from public.push_tokens$$,
  $$values ('ExponentPushToken[user-a-token]'::text, 'android'::text, 'aaaaaaaa-1111-4111-8111-111111111111'::uuid)$$,
  'unfiltered select as user A returns only user A token, owned by the caller'
);

select throws_ok(
  $$insert into public.push_tokens (user_id, token, platform)
    values ('bbbbbbbb-2222-4222-8222-222222222222'::uuid, 'ExponentPushToken[spoof]', 'ios')$$,
  '42501',
  null,
  'user A cannot insert a push token for user B'
);

select throws_ok(
  $$select public.register_push_token('ExponentPushToken[web-token]', 'web')$$,
  '23514',
  null,
  'platform check constraint rejects unsupported platform values'
);

select throws_ok(
  $$select public.register_push_token('   ', 'ios')$$,
  '23514',
  null,
  'token check constraint rejects blank push tokens'
);

select throws_ok(
  $$select public.register_push_token('not-an-expo-token', 'ios')$$,
  '23514',
  null,
  'token check constraint rejects values that are not Expo push tokens'
);

select throws_ok(
  $$update public.push_tokens
       set user_id = 'bbbbbbbb-2222-4222-8222-222222222222'::uuid
     where user_id = 'aaaaaaaa-1111-4111-8111-111111111111'::uuid$$,
  '42501',
  null,
  'user A cannot reassign their push token to user B'
);

delete from public.push_tokens where user_id = 'bbbbbbbb-2222-4222-8222-222222222222'::uuid;

set local role postgres;
select is(
  (select count(*)::int from public.push_tokens where user_id = 'bbbbbbbb-2222-4222-8222-222222222222'::uuid),
  1,
  'user A cannot delete user B push token'
);

-- Shared phone: user B signs in on user A's phone and registers the same token.
-- The token must move to B, so A's family pushes stop arriving on B's phone.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'bbbbbbbb-2222-4222-8222-222222222222', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"bbbbbbbb-2222-4222-8222-222222222222","role":"authenticated"}',
  true
);
select public.register_push_token('ExponentPushToken[user-a-token]', 'android');

set local role postgres;
select results_eq(
  $$select user_id from public.push_tokens where token = 'ExponentPushToken[user-a-token]'$$,
  $$values ('bbbbbbbb-2222-4222-8222-222222222222'::uuid)$$,
  'a token registered by a second user on the same phone moves to that user'
);
select is(
  (select count(*)::int from public.push_tokens where user_id = 'aaaaaaaa-1111-4111-8111-111111111111'::uuid),
  0,
  'the first user keeps no row for that phone'
);

-- User A signs in again on a new phone, then signs out and deletes that phone's token.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-1111-4111-8111-111111111111', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"aaaaaaaa-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);
select public.register_push_token('ExponentPushToken[user-a-new-phone]', 'ios');
delete from public.push_tokens where token = 'ExponentPushToken[user-a-new-phone]';
select is_empty(
  $$select token from public.push_tokens where user_id = 'aaaaaaaa-1111-4111-8111-111111111111'::uuid$$,
  'user A can delete their own push token'
);

set local role postgres;
delete from auth.users where id = 'bbbbbbbb-2222-4222-8222-222222222222'::uuid;
select is(
  (select count(*)::int from public.push_tokens where user_id = 'bbbbbbbb-2222-4222-8222-222222222222'::uuid),
  0,
  'deleting auth.users row cascades to push_tokens'
);

select * from finish();
rollback;
