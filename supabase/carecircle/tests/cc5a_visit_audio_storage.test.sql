-- CC-5a: Visit audio Storage bucket (`visit-audio`), RLS policies, and 24h clean-up list.
-- Modelled on `rx_storage_rls.test.sql`:
-- 1. Private bucket `visit-audio` (`public = false`), `audio/mp4` and `audio/m4a` only,
--    10 MB limit (`file_size_limit = 10485760`), path `<circle_id>/<uuid>.m4a`.
-- 2. Storage policies on `storage.objects`: only `owner` and `helper` of `<circle_id>` in the path
--    can `INSERT` and `DELETE`. Nobody can `SELECT` through the client API (owner, helper, viewer,
--    other circles, non-members, and anon all read 0 rows; only `service_role` reads).
-- 3. `public.list_expired_visit_audio(p_limit integer default 1000) returns setof text` returns
--    expired `visit-audio` objects older than 24 hours, oldest first, for `service_role` only.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, storage, extensions;

select plan(44);

-- 1. Bucket `visit-audio` configuration
select is(
  (select public from storage.buckets where id = 'visit-audio'),
  false,
  'bucket visit-audio exists and is private (public = false)'
);

select is(
  (select file_size_limit from storage.buckets where id = 'visit-audio'),
  10485760::bigint,
  'bucket visit-audio enforces a 10 MB (10,485,760 bytes) file_size_limit'
);

select is(
  (select allowed_mime_types from storage.buckets where id = 'visit-audio'),
  array['audio/mp4', 'audio/m4a']::text[],
  'bucket visit-audio allows only audio/mp4 and audio/m4a'
);

-- Seed users and two circles:
-- Circle A: owner_a, helper_a, viewer_a, dual (viewer)
-- Circle B: owner_b, dual (helper)
-- Outsider: belongs to no circle
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('cc5a0001-0000-4000-8000-000000000001'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'cc5a-owner-a@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('cc5a0002-0000-4000-8000-000000000002'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'cc5a-helper-a@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('cc5a0003-0000-4000-8000-000000000003'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'cc5a-viewer-a@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('cc5a0004-0000-4000-8000-000000000004'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'cc5a-owner-b@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('cc5a0005-0000-4000-8000-000000000005'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'cc5a-outsider@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('cc5a0006-0000-4000-8000-000000000006'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'cc5a-dual@example.test', '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.circles (id, name, care_recipient_name, timezone, created_by)
values
  ('cc5ac001-0000-4000-8000-000000000001'::uuid, 'Family A', 'Alice', 'Europe/Paris', 'cc5a0001-0000-4000-8000-000000000001'::uuid),
  ('cc5ac002-0000-4000-8000-000000000002'::uuid, 'Family B', 'Bob', 'Europe/Paris', 'cc5a0004-0000-4000-8000-000000000004'::uuid);

insert into public.circle_members (circle_id, user_id, role)
values
  ('cc5ac001-0000-4000-8000-000000000001'::uuid, 'cc5a0001-0000-4000-8000-000000000001'::uuid, 'owner'),
  ('cc5ac001-0000-4000-8000-000000000001'::uuid, 'cc5a0002-0000-4000-8000-000000000002'::uuid, 'helper'),
  ('cc5ac001-0000-4000-8000-000000000001'::uuid, 'cc5a0003-0000-4000-8000-000000000003'::uuid, 'viewer'),
  ('cc5ac001-0000-4000-8000-000000000001'::uuid, 'cc5a0006-0000-4000-8000-000000000006'::uuid, 'viewer'),
  ('cc5ac002-0000-4000-8000-000000000002'::uuid, 'cc5a0004-0000-4000-8000-000000000004'::uuid, 'owner'),
  ('cc5ac002-0000-4000-8000-000000000002'::uuid, 'cc5a0006-0000-4000-8000-000000000006'::uuid, 'helper');

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

create or replace function pg_temp.api_delete(p_name text)
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  perform set_config('storage.allow_delete_query', 'true', true);
  delete from storage.objects where bucket_id = 'visit-audio' and name = p_name;
  get diagnostics n = row_count;
  perform set_config('storage.allow_delete_query', 'false', true);
  return n;
end;
$$;

create or replace function pg_temp.try_sql(p_sql text)
returns void
language plpgsql
as $$
begin
  execute p_sql;
exception when others then
  null;
end;
$$;

create or replace function pg_temp.audio_exists(p_name text)
returns boolean
language sql
as $$
  select exists (select 1 from storage.objects where bucket_id = 'visit-audio' and name = p_name);
$$;

grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- 2. Upload (INSERT): owner and helper of Circle A can upload `<circle_id>/<uuid>.m4a`
select pg_temp.as_user('cc5a0001-0000-4000-8000-000000000001'::uuid);
select lives_ok(
  $$insert into storage.objects (id, bucket_id, name, owner, metadata)
    values (
      'cc5af001-0000-4000-8000-000000000001'::uuid,
      'visit-audio',
      'cc5ac001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.m4a',
      'cc5a0001-0000-4000-8000-000000000001'::uuid,
      '{"mimetype":"audio/m4a","size":520000}'::jsonb
    )$$,
  'circle owner can upload <circle_id>/<uuid>.m4a to visit-audio'
);

select pg_temp.as_user('cc5a0002-0000-4000-8000-000000000002'::uuid);
select lives_ok(
  $$insert into storage.objects (id, bucket_id, name, owner, metadata)
    values (
      'cc5af002-0000-4000-8000-000000000002'::uuid,
      'visit-audio',
      'cc5ac001-0000-4000-8000-000000000001/22222222-2222-4222-8222-222222222222.m4a',
      'cc5a0002-0000-4000-8000-000000000002'::uuid,
      '{"mimetype":"audio/mp4","size":650000}'::jsonb
    )$$,
  'circle helper can upload <circle_id>/<uuid>.m4a to visit-audio'
);

select pg_temp.as_user('cc5a0004-0000-4000-8000-000000000004'::uuid);
select lives_ok(
  $$insert into storage.objects (id, bucket_id, name, owner, metadata)
    values (
      'cc5af00b-0000-4000-8000-00000000000b'::uuid,
      'visit-audio',
      'cc5ac002-0000-4000-8000-000000000002/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.m4a',
      'cc5a0004-0000-4000-8000-000000000004'::uuid,
      '{"mimetype":"audio/m4a","size":490000}'::jsonb
    )$$,
  'Circle B owner can upload to Circle B''s own path'
);

-- 3. Upload (INSERT) refused for viewer, another family's owner, outsider, dual-role user, and anon
select pg_temp.as_user('cc5a0003-0000-4000-8000-000000000003'::uuid);
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner)
    values (
      'visit-audio',
      'cc5ac001-0000-4000-8000-000000000001/33333333-3333-4333-8333-333333333333.m4a',
      'cc5a0003-0000-4000-8000-000000000003'::uuid
    )$$,
  '42501',
  null,
  'circle viewer is refused upload to visit-audio'
);

select pg_temp.as_user('cc5a0004-0000-4000-8000-000000000004'::uuid);
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner)
    values (
      'visit-audio',
      'cc5ac001-0000-4000-8000-000000000001/44444444-4444-4444-8444-444444444444.m4a',
      'cc5a0004-0000-4000-8000-000000000004'::uuid
    )$$,
  '42501',
  null,
  'another family''s owner is refused upload to Circle A''s path'
);

select pg_temp.as_user('cc5a0005-0000-4000-8000-000000000005'::uuid);
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner)
    values (
      'visit-audio',
      'cc5ac001-0000-4000-8000-000000000001/55555555-5555-4555-8555-555555555555.m4a',
      'cc5a0005-0000-4000-8000-000000000005'::uuid
    )$$,
  '42501',
  null,
  'non-member user is refused upload to visit-audio'
);

select pg_temp.as_user('cc5a0006-0000-4000-8000-000000000006'::uuid);
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner)
    values (
      'visit-audio',
      'cc5ac001-0000-4000-8000-000000000001/66666666-6666-4666-8666-666666666661.m4a',
      'cc5a0006-0000-4000-8000-000000000006'::uuid
    )$$,
  '42501',
  null,
  'a helper of Circle B who is only a viewer of Circle A is refused upload to Circle A'
);

select lives_ok(
  $$insert into storage.objects (id, bucket_id, name, owner)
    values (
      'cc5af00c-0000-4000-8000-00000000000c'::uuid,
      'visit-audio',
      'cc5ac002-0000-4000-8000-000000000002/cccccccc-cccc-4ccc-8ccc-cccccccccccc.m4a',
      'cc5a0006-0000-4000-8000-000000000006'::uuid
    )$$,
  'the same person can upload to Circle B, where they are a helper'
);

select pg_temp.as_anon();
select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values (
      'visit-audio',
      'cc5ac001-0000-4000-8000-000000000001/66666666-6666-4666-8666-666666666666.m4a'
    )$$,
  '42501',
  null,
  'anonymous caller is refused upload to visit-audio'
);

-- 4. Path pattern enforcement on INSERT (<circle_id>/<uuid>.m4a only)
select pg_temp.as_user('cc5a0001-0000-4000-8000-000000000001'::uuid);
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner)
    values (
      'visit-audio',
      'cc5ac001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.wav',
      'cc5a0001-0000-4000-8000-000000000001'::uuid
    )$$,
  '42501',
  null,
  'upload with non-.m4a extension (.wav) is refused even for circle owner'
);

select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner)
    values (
      'visit-audio',
      'cc5ac001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.m4a.mp3',
      'cc5a0001-0000-4000-8000-000000000001'::uuid
    )$$,
  '42501',
  null,
  'upload with a second extension after .m4a is refused even for circle owner'
);

select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner)
    values (
      'visit-audio',
      'cc5ac001-0000-4000-8000-000000000001/not-a-uuid.m4a',
      'cc5a0001-0000-4000-8000-000000000001'::uuid
    )$$,
  '42501',
  null,
  'upload with non-UUID filename is refused even for circle owner'
);

select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner)
    values (
      'visit-audio',
      'cc5ac001-0000-4000-8000-000000000001/nested/11111111-1111-4111-8111-111111111111.m4a',
      'cc5a0001-0000-4000-8000-000000000001'::uuid
    )$$,
  '42501',
  null,
  'upload with nested path segments is refused even for circle owner'
);

select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner)
    values (
      'visit-audio',
      'family-a/11111111-1111-4111-8111-111111111111.m4a',
      'cc5a0001-0000-4000-8000-000000000001'::uuid
    )$$,
  '42501',
  null,
  'upload whose first folder is not a circle UUID is refused with 42501 (not a cast error)'
);

select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner)
    values (
      'visit-audio',
      'cc5ac001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.m4a/x',
      'cc5a0001-0000-4000-8000-000000000001'::uuid
    )$$,
  '42501',
  null,
  'upload with anything after <uuid>.m4a is refused even for circle owner'
);

select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner)
    values (
      'visit-audio',
      'x/cc5ac001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.m4a',
      'cc5a0001-0000-4000-8000-000000000001'::uuid
    )$$,
  '42501',
  null,
  'upload with a folder before <circle_id> is refused even for circle owner'
);

-- 5. Read (SELECT): NOBODY may read through the client API (owner, helper, viewer, other circle,
--    non-member, and anon all see 0 rows; only service_role reads).
select pg_temp.as_user('cc5a0001-0000-4000-8000-000000000001'::uuid);
select is(
  (select count(*)::int from storage.objects where bucket_id = 'visit-audio'),
  0,
  'circle owner sees 0 visit-audio rows through the client API (gateway reads with service_role)'
);

select pg_temp.as_user('cc5a0002-0000-4000-8000-000000000002'::uuid);
select is(
  (select count(*)::int from storage.objects where bucket_id = 'visit-audio'),
  0,
  'circle helper sees 0 visit-audio rows through the client API'
);

select pg_temp.as_user('cc5a0003-0000-4000-8000-000000000003'::uuid);
select is(
  (select count(*)::int from storage.objects where bucket_id = 'visit-audio'),
  0,
  'circle viewer sees 0 visit-audio rows'
);

select pg_temp.as_user('cc5a0004-0000-4000-8000-000000000004'::uuid);
select is(
  (select count(*)::int from storage.objects where bucket_id = 'visit-audio'),
  0,
  'another family''s owner sees 0 visit-audio rows'
);

select pg_temp.as_user('cc5a0006-0000-4000-8000-000000000006'::uuid);
select is(
  (select count(*)::int from storage.objects where bucket_id = 'visit-audio'),
  0,
  'dual-role member sees 0 visit-audio rows through the client API'
);

select pg_temp.as_user('cc5a0005-0000-4000-8000-000000000005'::uuid);
select is(
  (select count(*)::int from storage.objects where bucket_id = 'visit-audio'),
  0,
  'non-member sees 0 visit-audio rows'
);

select pg_temp.as_anon();
select is(
  (select count(*)::int from storage.objects where bucket_id = 'visit-audio'),
  0,
  'anonymous caller sees 0 visit-audio rows'
);

set local role service_role;
select is(
  (select count(*)::int from storage.objects where bucket_id = 'visit-audio'),
  4,
  'service_role (AI gateway) can read visit-audio objects'
);

-- 6. No UPDATE allowed on visit-audio
select pg_temp.as_user('cc5a0001-0000-4000-8000-000000000001'::uuid);
select pg_temp.try_sql($$update storage.objects
   set metadata = '{"mimetype":"audio/m4a","size":999}'::jsonb
 where id = 'cc5af001-0000-4000-8000-000000000001'::uuid$$);
select pg_temp.try_sql($$update storage.objects
   set name = 'cc5ac002-0000-4000-8000-000000000002/11111111-1111-4111-8111-111111111111.m4a'
 where id = 'cc5af001-0000-4000-8000-000000000001'::uuid$$);

select pg_temp.as_user('cc5a0006-0000-4000-8000-000000000006'::uuid);
select pg_temp.try_sql($$update storage.objects
   set name = 'cc5ac001-0000-4000-8000-000000000001/cccccccc-cccc-4ccc-8ccc-cccccccccccc.m4a'
 where id = 'cc5af00c-0000-4000-8000-00000000000c'::uuid$$);

set local role postgres;
select is(
  (select (metadata->>'size')::int from storage.objects where id = 'cc5af001-0000-4000-8000-000000000001'::uuid),
  520000,
  'circle owner cannot update an existing visit-audio object'
);
select is(
  (select name from storage.objects where id = 'cc5af001-0000-4000-8000-000000000001'::uuid),
  'cc5ac001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.m4a',
  'circle owner cannot move a visit-audio object into another circle''s folder'
);
select is(
  (select name from storage.objects where id = 'cc5af00c-0000-4000-8000-00000000000c'::uuid),
  'cc5ac002-0000-4000-8000-000000000002/cccccccc-cccc-4ccc-8ccc-cccccccccccc.m4a',
  'a Circle B helper cannot move a Circle B visit-audio object into Circle A''s folder'
);

-- 7. Delete (through the Storage API): viewer, other family's owner, dual-role user, outsider and anon
--    delete nothing; helper and owner of the circle can.
select pg_temp.as_user('cc5a0003-0000-4000-8000-000000000003'::uuid);
select is(
  pg_temp.api_delete('cc5ac001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.m4a'),
  0,
  'circle viewer cannot delete a Circle A visit-audio recording'
);

select pg_temp.as_user('cc5a0004-0000-4000-8000-000000000004'::uuid);
select is(
  pg_temp.api_delete('cc5ac001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.m4a'),
  0,
  'another family''s owner cannot delete a Circle A visit-audio recording'
);

select pg_temp.as_user('cc5a0006-0000-4000-8000-000000000006'::uuid);
select is(
  pg_temp.api_delete('cc5ac001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.m4a'),
  0,
  'a helper of Circle B who is only a viewer of Circle A cannot delete a Circle A visit-audio recording'
);

select pg_temp.as_user('cc5a0005-0000-4000-8000-000000000005'::uuid);
select is(
  pg_temp.api_delete('cc5ac001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.m4a'),
  0,
  'non-member cannot delete a Circle A visit-audio recording'
);

select pg_temp.as_anon();
select is(
  pg_temp.api_delete('cc5ac001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.m4a'),
  0,
  'anonymous caller cannot delete a Circle A visit-audio recording'
);

set local role postgres;
select ok(
  pg_temp.audio_exists('cc5ac001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.m4a'),
  'the Circle A visit-audio recording is still there after all refused deletes'
);

select pg_temp.as_user('cc5a0002-0000-4000-8000-000000000002'::uuid);
select is(
  pg_temp.api_delete('cc5ac001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.m4a'),
  1,
  'circle helper can delete the owner''s visit-audio recording'
);

select pg_temp.as_user('cc5a0001-0000-4000-8000-000000000001'::uuid);
select is(
  pg_temp.api_delete('cc5ac001-0000-4000-8000-000000000001/22222222-2222-4222-8222-222222222222.m4a'),
  1,
  'circle owner can delete the helper''s visit-audio recording'
);

-- 8. A helper who leaves the circle loses upload and delete access at once
set local role postgres;
insert into storage.objects (id, bucket_id, name, owner, owner_id)
values (
  'cc5af00d-0000-4000-8000-00000000000d'::uuid,
  'visit-audio',
  'cc5ac001-0000-4000-8000-000000000001/dddddddd-dddd-4ddd-8ddd-dddddddddddd.m4a',
  'cc5a0002-0000-4000-8000-000000000002'::uuid,
  'cc5a0002-0000-4000-8000-000000000002'
);

delete from public.circle_members
 where circle_id = 'cc5ac001-0000-4000-8000-000000000001'::uuid
   and user_id = 'cc5a0002-0000-4000-8000-000000000002'::uuid;

select pg_temp.as_user('cc5a0002-0000-4000-8000-000000000002'::uuid);
select is(
  pg_temp.api_delete('cc5ac001-0000-4000-8000-000000000001/dddddddd-dddd-4ddd-8ddd-dddddddddddd.m4a'),
  0,
  'a former helper cannot delete the visit-audio recording they uploaded'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner)
    values (
      'visit-audio',
      'cc5ac001-0000-4000-8000-000000000001/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.m4a',
      'cc5a0002-0000-4000-8000-000000000002'::uuid
    )$$,
  '42501',
  null,
  'a former helper is refused upload to visit-audio'
);

-- 9. Scheduled 24-hour clean-up list (`public.list_expired_visit_audio`)
set local role postgres;

insert into storage.objects (id, bucket_id, name, owner, created_at)
values
  (
    'cc5af003-0000-4000-8000-000000000003'::uuid,
    'visit-audio',
    'cc5ac001-0000-4000-8000-000000000001/77777777-7777-4777-8777-777777777777.m4a',
    'cc5a0001-0000-4000-8000-000000000001'::uuid,
    now() - interval '24 hours 1 minute'
  ),
  (
    'cc5af006-0000-4000-8000-000000000006'::uuid,
    'visit-audio',
    'cc5ac002-0000-4000-8000-000000000002/99999999-9999-4999-8999-999999999999.m4a',
    'cc5a0004-0000-4000-8000-000000000004'::uuid,
    now() - interval '3 days'
  ),
  (
    'cc5af004-0000-4000-8000-000000000004'::uuid,
    'visit-audio',
    'cc5ac001-0000-4000-8000-000000000001/88888888-8888-4888-8888-888888888888.m4a',
    'cc5a0001-0000-4000-8000-000000000001'::uuid,
    now() - interval '23 hours 50 minutes'
  );

select pg_temp.as_user('cc5a0001-0000-4000-8000-000000000001'::uuid);
select throws_ok(
  $$select * from public.list_expired_visit_audio()$$,
  '42501',
  null,
  'authenticated role cannot execute public.list_expired_visit_audio()'
);

select pg_temp.as_anon();
select throws_ok(
  $$select * from public.list_expired_visit_audio()$$,
  '42501',
  null,
  'anon role cannot execute public.list_expired_visit_audio()'
);

set local role service_role;
select results_eq(
  $$select * from public.list_expired_visit_audio()$$,
  $$values
    ('cc5ac002-0000-4000-8000-000000000002/99999999-9999-4999-8999-999999999999.m4a'::text),
    ('cc5ac001-0000-4000-8000-000000000001/77777777-7777-4777-8777-777777777777.m4a'::text)$$,
  'service_role gets every visit-audio object older than 24 hours, from every circle, oldest first; nothing newer'
);

select results_eq(
  $$select * from public.list_expired_visit_audio(1)$$,
  $$values ('cc5ac002-0000-4000-8000-000000000002/99999999-9999-4999-8999-999999999999.m4a'::text)$$,
  'list_expired_visit_audio(p_limit) returns at most p_limit names (oldest first)'
);

select * from finish();

rollback;
