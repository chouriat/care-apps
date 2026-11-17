-- CC-7: Private `log-exports` Storage bucket (`service_role` only; no client role may read or write)
-- and 24-hour clean-up list (`public.list_expired_log_exports`).

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, storage, extensions;

select plan(20);

-- 1. Bucket `log-exports` configuration
select is(
  (select public from storage.buckets where id = 'log-exports'),
  false,
  'bucket log-exports exists and is private (public = false)'
);

select is(
  (select file_size_limit from storage.buckets where id = 'log-exports'),
  10485760::bigint,
  'bucket log-exports enforces a 10 MB (10,485,760 bytes) file_size_limit'
);

select is(
  (select allowed_mime_types from storage.buckets where id = 'log-exports'),
  array['application/pdf']::text[],
  'bucket log-exports allows only application/pdf'
);

-- Seed users and a circle
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('cc700001-0000-4000-8000-000000000001'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'cc7-owner@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('cc700002-0000-4000-8000-000000000002'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'cc7-helper@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('cc700003-0000-4000-8000-000000000003'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'cc7-viewer@example.test', '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.circles (id, name, care_recipient_name, timezone, created_by)
values ('cc7c0001-0000-4000-8000-000000000001'::uuid, 'Family Care', 'Evelyn', 'Europe/Paris', 'cc700001-0000-4000-8000-000000000001'::uuid);

insert into public.circle_members (circle_id, user_id, role)
values
  ('cc7c0001-0000-4000-8000-000000000001'::uuid, 'cc700001-0000-4000-8000-000000000001'::uuid, 'owner'),
  ('cc7c0001-0000-4000-8000-000000000001'::uuid, 'cc700002-0000-4000-8000-000000000002'::uuid, 'helper'),
  ('cc7c0001-0000-4000-8000-000000000001'::uuid, 'cc700003-0000-4000-8000-000000000003'::uuid, 'viewer');

-- Seed one PDF object in log-exports as service_role
set local role service_role;
insert into storage.objects (id, bucket_id, name, owner, metadata)
values (
  'cc7f0001-0000-4000-8000-000000000001'::uuid,
  'log-exports',
  'cc7c0001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.pdf',
  'cc700001-0000-4000-8000-000000000001'::uuid,
  '{"mimetype":"application/pdf","size":12345}'::jsonb
);
reset role;

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

create or replace function pg_temp.api_delete_export(p_name text)
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  perform set_config('storage.allow_delete_query', 'true', true);
  delete from storage.objects where bucket_id = 'log-exports' and name = p_name;
  get diagnostics n = row_count;
  perform set_config('storage.allow_delete_query', 'false', true);
  return n;
end;
$$;

create or replace function pg_temp.try_update_export(p_id uuid)
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  update storage.objects set name = 'cc7c0001-0000-4000-8000-000000000001/hacked.pdf' where id = p_id;
  get diagnostics n = row_count;
  return n;
exception when others then
  return 0;
end;
$$;

grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- 2. Authenticated circle owner cannot SELECT, INSERT, UPDATE, or DELETE in log-exports
select pg_temp.as_user('cc700001-0000-4000-8000-000000000001'::uuid);
select is(
  (select count(*)::int from storage.objects where bucket_id = 'log-exports'),
  0,
  'authenticated circle owner cannot SELECT any object in log-exports'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner)
    values ('log-exports', 'cc7c0001-0000-4000-8000-000000000001/22222222-2222-4222-8222-222222222222.pdf', 'cc700001-0000-4000-8000-000000000001'::uuid)$$,
  '42501',
  null,
  'authenticated circle owner cannot INSERT into log-exports'
);
select is(
  pg_temp.try_update_export('cc7f0001-0000-4000-8000-000000000001'::uuid),
  0,
  'authenticated circle owner cannot UPDATE any object in log-exports'
);
select is(
  pg_temp.api_delete_export('cc7c0001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.pdf'),
  0,
  'authenticated circle owner cannot DELETE any object in log-exports'
);

-- 3. Authenticated helper and viewer also cannot SELECT or INSERT
select pg_temp.as_user('cc700002-0000-4000-8000-000000000002'::uuid);
select is(
  (select count(*)::int from storage.objects where bucket_id = 'log-exports'),
  0,
  'authenticated circle helper cannot SELECT any object in log-exports'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner)
    values ('log-exports', 'cc7c0001-0000-4000-8000-000000000001/33333333-3333-4333-8333-333333333333.pdf', 'cc700002-0000-4000-8000-000000000002'::uuid)$$,
  '42501',
  null,
  'authenticated circle helper cannot INSERT into log-exports'
);

select pg_temp.as_user('cc700003-0000-4000-8000-000000000003'::uuid);
select is(
  (select count(*)::int from storage.objects where bucket_id = 'log-exports'),
  0,
  'authenticated circle viewer cannot SELECT any object in log-exports'
);

-- 4. Anonymous role cannot SELECT, INSERT, UPDATE, or DELETE in log-exports
select pg_temp.as_anon();
select is(
  (select count(*)::int from storage.objects where bucket_id = 'log-exports'),
  0,
  'anon role cannot SELECT any object in log-exports'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('log-exports', 'cc7c0001-0000-4000-8000-000000000001/44444444-4444-4444-8444-444444444444.pdf')$$,
  '42501',
  null,
  'anon role cannot INSERT into log-exports'
);
select is(
  pg_temp.try_update_export('cc7f0001-0000-4000-8000-000000000001'::uuid),
  0,
  'anon role cannot UPDATE any object in log-exports'
);
select is(
  pg_temp.api_delete_export('cc7c0001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.pdf'),
  0,
  'anon role cannot DELETE any object in log-exports'
);

-- 5. service_role still sees the intact object
set local role service_role;
select is(
  (select count(*)::int from storage.objects where bucket_id = 'log-exports' and name = 'cc7c0001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.pdf'),
  1,
  'service_role can read log-exports objects and the seeded object is still intact'
);

-- 6. Scheduled 24-hour clean-up list (`public.list_expired_log_exports`)
set local role postgres;
insert into storage.objects (id, bucket_id, name, owner, created_at)
values
  (
    'cc7f0002-0000-4000-8000-000000000002'::uuid,
    'log-exports',
    'cc7c0001-0000-4000-8000-000000000001/77777777-7777-4777-8777-777777777777.pdf',
    'cc700001-0000-4000-8000-000000000001'::uuid,
    now() - interval '24 hours 1 minute'
  ),
  (
    'cc7f0003-0000-4000-8000-000000000003'::uuid,
    'log-exports',
    'cc7c0001-0000-4000-8000-000000000001/99999999-9999-4999-8999-999999999999.pdf',
    'cc700001-0000-4000-8000-000000000001'::uuid,
    now() - interval '2 days'
  );

select pg_temp.as_user('cc700001-0000-4000-8000-000000000001'::uuid);
select throws_ok(
  $$select * from public.list_expired_log_exports()$$,
  '42501',
  null,
  'authenticated role cannot execute public.list_expired_log_exports()'
);

select pg_temp.as_anon();
select throws_ok(
  $$select * from public.list_expired_log_exports()$$,
  '42501',
  null,
  'anon role cannot execute public.list_expired_log_exports()'
);

set local role service_role;
select results_eq(
  $$select * from public.list_expired_log_exports()$$,
  $$values
    ('cc7c0001-0000-4000-8000-000000000001/99999999-9999-4999-8999-999999999999.pdf'::text),
    ('cc7c0001-0000-4000-8000-000000000001/77777777-7777-4777-8777-777777777777.pdf'::text)$$,
  'service_role gets every log-exports object older than 24 hours, oldest first; nothing newer'
);

select results_eq(
  $$select * from public.list_expired_log_exports(1)$$,
  $$values ('cc7c0001-0000-4000-8000-000000000001/99999999-9999-4999-8999-999999999999.pdf'::text)$$,
  'list_expired_log_exports(p_limit) returns at most p_limit names (oldest first)'
);

select * from finish();

rollback;
