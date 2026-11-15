-- CC-4a pre-work [safety 1/2]: Prescription photos Storage bucket, RLS policies, and 24h clean-up list.
-- Rules (decided 2026-11-15):
-- 1. Private bucket `prescription-photos` (`public = false`), `image/jpeg` only (`allowed_mime_types = array['image/jpeg']`),
--    2 MB limit (`file_size_limit = 2097152`), path `<circle_id>/<uuid>.jpg` (lowercase UUIDs, nothing else).
-- 2. Storage policies on `storage.objects`: only `owner` and `helper` of `<circle_id>` in the path
--    can `INSERT`, `SELECT`, and `DELETE`. Viewers, other families' owners/helpers, people who are
--    owner/helper of ANOTHER circle but only viewer of this one, former members, outsiders, and `anon`
--    get nothing. No `UPDATE` for anyone (a retake is a new upload).
-- 3. Scheduled clean-up. Supabase refuses `delete from storage.objects` in SQL ("Use the Storage API
--    instead"): a SQL delete would only remove the row and leave the photo file itself in the bucket.
--    So the database only LISTS what is expired, and the `cleanup-prescription-photos` Edge Function
--    deletes those paths through the Storage API (Deno tests in functions/cleanup-prescription-photos/).
--    `public.list_expired_prescription_photos(p_limit integer default 1000) returns setof text` returns
--    the `name` of every object in `prescription-photos` with `created_at < now() - interval '24 hours'`,
--    oldest first, at most `p_limit` names, and only `service_role` may execute it.
--
-- How deletes are simulated: the Storage API deletes a row as the signed-in user (so RLS applies) after
-- `set_config('storage.allow_delete_query', 'true', true)` in its own transaction. `pg_temp.api_delete`
-- does the same, and returns how many rows the caller's RLS let it delete.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, storage, extensions;

select plan(46);

-- 1. Bucket `prescription-photos` configuration
select is(
  (select public from storage.buckets where id = 'prescription-photos'),
  false,
  'bucket prescription-photos exists and is private (public = false)'
);

select is(
  (select file_size_limit from storage.buckets where id = 'prescription-photos'),
  2097152::bigint,
  'bucket prescription-photos enforces a 2 MB (2,097,152 bytes) file_size_limit'
);

select is(
  (select allowed_mime_types from storage.buckets where id = 'prescription-photos'),
  array['image/jpeg']::text[],
  'bucket prescription-photos allows only image/jpeg'
);

-- Seed users and two circles:
-- Circle A: owner_a, helper_a, viewer_a, dual (viewer)
-- Circle B: owner_b, dual (helper)
-- Outsider: belongs to no circle
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('cc4a0001-0000-4000-8000-000000000001'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'owner-a@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('cc4a0002-0000-4000-8000-000000000002'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'helper-a@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('cc4a0003-0000-4000-8000-000000000003'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'viewer-a@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('cc4a0004-0000-4000-8000-000000000004'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'owner-b@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('cc4a0005-0000-4000-8000-000000000005'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'outsider@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('cc4a0006-0000-4000-8000-000000000006'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'dual@example.test', '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.circles (id, name, care_recipient_name, timezone, created_by)
values
  ('cc4ac001-0000-4000-8000-000000000001'::uuid, 'Family A', 'Alice', 'Europe/Paris', 'cc4a0001-0000-4000-8000-000000000001'::uuid),
  ('cc4ac002-0000-4000-8000-000000000002'::uuid, 'Family B', 'Bob', 'Europe/Paris', 'cc4a0004-0000-4000-8000-000000000004'::uuid);

insert into public.circle_members (circle_id, user_id, role)
values
  ('cc4ac001-0000-4000-8000-000000000001'::uuid, 'cc4a0001-0000-4000-8000-000000000001'::uuid, 'owner'),
  ('cc4ac001-0000-4000-8000-000000000001'::uuid, 'cc4a0002-0000-4000-8000-000000000002'::uuid, 'helper'),
  ('cc4ac001-0000-4000-8000-000000000001'::uuid, 'cc4a0003-0000-4000-8000-000000000003'::uuid, 'viewer'),
  ('cc4ac001-0000-4000-8000-000000000001'::uuid, 'cc4a0006-0000-4000-8000-000000000006'::uuid, 'viewer'),
  ('cc4ac002-0000-4000-8000-000000000002'::uuid, 'cc4a0004-0000-4000-8000-000000000004'::uuid, 'owner'),
  ('cc4ac002-0000-4000-8000-000000000002'::uuid, 'cc4a0006-0000-4000-8000-000000000006'::uuid, 'helper');

-- Helper to switch the simulated PostgREST caller
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

-- Deletes like the Storage API does (as the current caller, RLS applies); returns rows deleted.
create or replace function pg_temp.api_delete(p_name text)
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  perform set_config('storage.allow_delete_query', 'true', true);
  delete from storage.objects where bucket_id = 'prescription-photos' and name = p_name;
  get diagnostics n = row_count;
  perform set_config('storage.allow_delete_query', 'false', true);
  return n;
end;
$$;

-- Runs one statement as the current caller and swallows its error, so a refused write cannot abort the file.
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

create or replace function pg_temp.photo_exists(p_name text)
returns boolean
language sql
as $$
  select exists (select 1 from storage.objects where bucket_id = 'prescription-photos' and name = p_name);
$$;

grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- 2. Upload (INSERT): owner and helper of Circle A can upload `<circle_id>/<uuid>.jpg`
select pg_temp.as_user('cc4a0001-0000-4000-8000-000000000001'::uuid);
select lives_ok(
  $$insert into storage.objects (id, bucket_id, name, owner, metadata)
    values (
      'cc4af001-0000-4000-8000-000000000001'::uuid,
      'prescription-photos',
      'cc4ac001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.jpg',
      'cc4a0001-0000-4000-8000-000000000001'::uuid,
      '{"mimetype":"image/jpeg","size":120000}'::jsonb
    )$$,
  'circle owner can upload <circle_id>/<uuid>.jpg to prescription-photos'
);

select pg_temp.as_user('cc4a0002-0000-4000-8000-000000000002'::uuid);
select lives_ok(
  $$insert into storage.objects (id, bucket_id, name, owner, metadata)
    values (
      'cc4af002-0000-4000-8000-000000000002'::uuid,
      'prescription-photos',
      'cc4ac001-0000-4000-8000-000000000001/22222222-2222-4222-8222-222222222222.jpg',
      'cc4a0002-0000-4000-8000-000000000002'::uuid,
      '{"mimetype":"image/jpeg","size":150000}'::jsonb
    )$$,
  'circle helper can upload <circle_id>/<uuid>.jpg to prescription-photos'
);

-- Circle B has its own photo (uploaded by its owner), so "sees nothing" checks below are meaningful.
select pg_temp.as_user('cc4a0004-0000-4000-8000-000000000004'::uuid);
select lives_ok(
  $$insert into storage.objects (id, bucket_id, name, owner, metadata)
    values (
      'cc4af00b-0000-4000-8000-00000000000b'::uuid,
      'prescription-photos',
      'cc4ac002-0000-4000-8000-000000000002/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg',
      'cc4a0004-0000-4000-8000-000000000004'::uuid,
      '{"mimetype":"image/jpeg","size":90000}'::jsonb
    )$$,
  'Circle B owner can upload to Circle B''s own path'
);

-- 3. Upload (INSERT) refused for viewer, another family's owner, outsider, dual-role user, and anon
select pg_temp.as_user('cc4a0003-0000-4000-8000-000000000003'::uuid);
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner)
    values (
      'prescription-photos',
      'cc4ac001-0000-4000-8000-000000000001/33333333-3333-4333-8333-333333333333.jpg',
      'cc4a0003-0000-4000-8000-000000000003'::uuid
    )$$,
  '42501',
  null,
  'circle viewer is refused upload to prescription-photos'
);

select pg_temp.as_user('cc4a0004-0000-4000-8000-000000000004'::uuid);
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner)
    values (
      'prescription-photos',
      'cc4ac001-0000-4000-8000-000000000001/44444444-4444-4444-8444-444444444444.jpg',
      'cc4a0004-0000-4000-8000-000000000004'::uuid
    )$$,
  '42501',
  null,
  'another family''s owner is refused upload to Circle A''s path'
);

select pg_temp.as_user('cc4a0005-0000-4000-8000-000000000005'::uuid);
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner)
    values (
      'prescription-photos',
      'cc4ac001-0000-4000-8000-000000000001/55555555-5555-4555-8555-555555555555.jpg',
      'cc4a0005-0000-4000-8000-000000000005'::uuid
    )$$,
  '42501',
  null,
  'non-member user is refused upload to prescription-photos'
);

-- dual: helper in B, only viewer in A. The role must be checked in the circle of the path.
select pg_temp.as_user('cc4a0006-0000-4000-8000-000000000006'::uuid);
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner)
    values (
      'prescription-photos',
      'cc4ac001-0000-4000-8000-000000000001/66666666-6666-4666-8666-666666666661.jpg',
      'cc4a0006-0000-4000-8000-000000000006'::uuid
    )$$,
  '42501',
  null,
  'a helper of Circle B who is only a viewer of Circle A is refused upload to Circle A'
);

select lives_ok(
  $$insert into storage.objects (id, bucket_id, name, owner)
    values (
      'cc4af00c-0000-4000-8000-00000000000c'::uuid,
      'prescription-photos',
      'cc4ac002-0000-4000-8000-000000000002/cccccccc-cccc-4ccc-8ccc-cccccccccccc.jpg',
      'cc4a0006-0000-4000-8000-000000000006'::uuid
    )$$,
  'the same person can upload to Circle B, where they are a helper'
);

select pg_temp.as_anon();
select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values (
      'prescription-photos',
      'cc4ac001-0000-4000-8000-000000000001/66666666-6666-4666-8666-666666666666.jpg'
    )$$,
  '42501',
  null,
  'anonymous caller is refused upload to prescription-photos'
);

-- 4. Path pattern enforcement on INSERT (<circle_id>/<uuid>.jpg only). Every bad path is refused with
--    42501 (a policy that crashes on a cast, 22P02, fails these checks too).
select pg_temp.as_user('cc4a0001-0000-4000-8000-000000000001'::uuid);
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner)
    values (
      'prescription-photos',
      'cc4ac001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.png',
      'cc4a0001-0000-4000-8000-000000000001'::uuid
    )$$,
  '42501',
  null,
  'upload with non-.jpg extension (.png) is refused even for circle owner'
);

select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner)
    values (
      'prescription-photos',
      'cc4ac001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.jpg.png',
      'cc4a0001-0000-4000-8000-000000000001'::uuid
    )$$,
  '42501',
  null,
  'upload with a second extension after .jpg is refused even for circle owner'
);

select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner)
    values (
      'prescription-photos',
      'cc4ac001-0000-4000-8000-000000000001/not-a-uuid.jpg',
      'cc4a0001-0000-4000-8000-000000000001'::uuid
    )$$,
  '42501',
  null,
  'upload with non-UUID filename is refused even for circle owner'
);

select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner)
    values (
      'prescription-photos',
      'cc4ac001-0000-4000-8000-000000000001/nested/11111111-1111-4111-8111-111111111111.jpg',
      'cc4a0001-0000-4000-8000-000000000001'::uuid
    )$$,
  '42501',
  null,
  'upload with nested path segments is refused even for circle owner'
);

select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner)
    values (
      'prescription-photos',
      'family-a/11111111-1111-4111-8111-111111111111.jpg',
      'cc4a0001-0000-4000-8000-000000000001'::uuid
    )$$,
  '42501',
  null,
  'upload whose first folder is not a circle UUID is refused with 42501 (not a cast error)'
);

select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner)
    values (
      'prescription-photos',
      'cc4ac001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.jpg/x',
      'cc4a0001-0000-4000-8000-000000000001'::uuid
    )$$,
  '42501',
  null,
  'upload with anything after <uuid>.jpg is refused even for circle owner'
);

select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner)
    values (
      'prescription-photos',
      'x/cc4ac001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.jpg',
      'cc4a0001-0000-4000-8000-000000000001'::uuid
    )$$,
  '42501',
  null,
  'upload with a folder before <circle_id> is refused even for circle owner'
);

-- 5. Read (SELECT): only owner and helper of the circle in the path
select pg_temp.as_user('cc4a0001-0000-4000-8000-000000000001'::uuid);
select is(
  (select count(*)::int from storage.objects where bucket_id = 'prescription-photos'),
  2,
  'circle owner sees exactly Circle A''s 2 photos (not Circle B''s)'
);

select pg_temp.as_user('cc4a0002-0000-4000-8000-000000000002'::uuid);
select is(
  (select count(*)::int from storage.objects where bucket_id = 'prescription-photos'),
  2,
  'circle helper sees exactly Circle A''s 2 photos, including the owner''s upload'
);

select pg_temp.as_user('cc4a0003-0000-4000-8000-000000000003'::uuid);
select is(
  (select count(*)::int from storage.objects where bucket_id = 'prescription-photos'),
  0,
  'circle viewer sees 0 prescription photos'
);

select pg_temp.as_user('cc4a0004-0000-4000-8000-000000000004'::uuid);
select is(
  (select count(*)::int from storage.objects
    where bucket_id = 'prescription-photos' and name like 'cc4ac001-0000-4000-8000-000000000001/%'),
  0,
  'another family''s owner sees 0 prescription photos from Circle A'
);
select is(
  (select count(*)::int from storage.objects where bucket_id = 'prescription-photos'),
  2,
  'Circle B owner sees Circle B''s 2 photos, including the one a helper uploaded'
);

select pg_temp.as_user('cc4a0006-0000-4000-8000-000000000006'::uuid);
select is(
  (select count(*)::int from storage.objects
    where bucket_id = 'prescription-photos' and name like 'cc4ac001-0000-4000-8000-000000000001/%'),
  0,
  'a helper of Circle B who is only a viewer of Circle A sees 0 of Circle A''s photos'
);

select pg_temp.as_user('cc4a0005-0000-4000-8000-000000000005'::uuid);
select is(
  (select count(*)::int from storage.objects where bucket_id = 'prescription-photos'),
  0,
  'non-member sees 0 prescription photos'
);

select pg_temp.as_anon();
select is(
  (select count(*)::int from storage.objects where bucket_id = 'prescription-photos'),
  0,
  'anonymous caller sees 0 prescription photos'
);

-- 6. No UPDATE allowed on prescription-photos (a retake is a new upload). Includes moving a photo
--    into another circle's folder.
select pg_temp.as_user('cc4a0001-0000-4000-8000-000000000001'::uuid);
select pg_temp.try_sql($$update storage.objects
   set metadata = '{"mimetype":"image/jpeg","size":999}'::jsonb
 where id = 'cc4af001-0000-4000-8000-000000000001'::uuid$$);
select pg_temp.try_sql($$update storage.objects
   set name = 'cc4ac002-0000-4000-8000-000000000002/11111111-1111-4111-8111-111111111111.jpg'
 where id = 'cc4af001-0000-4000-8000-000000000001'::uuid$$);

select pg_temp.as_user('cc4a0006-0000-4000-8000-000000000006'::uuid);
select pg_temp.try_sql($$update storage.objects
   set name = 'cc4ac001-0000-4000-8000-000000000001/cccccccc-cccc-4ccc-8ccc-cccccccccccc.jpg'
 where id = 'cc4af00c-0000-4000-8000-00000000000c'::uuid$$);

set local role postgres;
select is(
  (select (metadata->>'size')::int from storage.objects where id = 'cc4af001-0000-4000-8000-000000000001'::uuid),
  120000,
  'circle owner cannot update an existing prescription photo (retake must be a new upload)'
);
select is(
  (select name from storage.objects where id = 'cc4af001-0000-4000-8000-000000000001'::uuid),
  'cc4ac001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.jpg',
  'circle owner cannot move a photo into another circle''s folder'
);
select is(
  (select name from storage.objects where id = 'cc4af00c-0000-4000-8000-00000000000c'::uuid),
  'cc4ac002-0000-4000-8000-000000000002/cccccccc-cccc-4ccc-8ccc-cccccccccccc.jpg',
  'a Circle B helper cannot move a Circle B photo into Circle A''s folder'
);

-- 7. Delete (through the Storage API): viewer, other family's owner, dual-role user, outsider and anon
--    delete nothing; helper and owner of the circle can.
select pg_temp.as_user('cc4a0003-0000-4000-8000-000000000003'::uuid);
select is(
  pg_temp.api_delete('cc4ac001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.jpg'),
  0,
  'circle viewer cannot delete a Circle A photo'
);

select pg_temp.as_user('cc4a0004-0000-4000-8000-000000000004'::uuid);
select is(
  pg_temp.api_delete('cc4ac001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.jpg'),
  0,
  'another family''s owner cannot delete a Circle A photo'
);

select pg_temp.as_user('cc4a0006-0000-4000-8000-000000000006'::uuid);
select is(
  pg_temp.api_delete('cc4ac001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.jpg'),
  0,
  'a helper of Circle B who is only a viewer of Circle A cannot delete a Circle A photo'
);

select pg_temp.as_user('cc4a0005-0000-4000-8000-000000000005'::uuid);
select is(
  pg_temp.api_delete('cc4ac001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.jpg'),
  0,
  'non-member cannot delete a Circle A photo'
);

select pg_temp.as_anon();
select is(
  pg_temp.api_delete('cc4ac001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.jpg'),
  0,
  'anonymous caller cannot delete a Circle A photo'
);

set local role postgres;
select ok(
  pg_temp.photo_exists('cc4ac001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.jpg'),
  'the Circle A photo is still there after all refused deletes'
);

select pg_temp.as_user('cc4a0002-0000-4000-8000-000000000002'::uuid);
select is(
  pg_temp.api_delete('cc4ac001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.jpg'),
  1,
  'circle helper can delete the owner''s photo when the medicine is saved or the draft is discarded'
);

select pg_temp.as_user('cc4a0001-0000-4000-8000-000000000001'::uuid);
select is(
  pg_temp.api_delete('cc4ac001-0000-4000-8000-000000000001/22222222-2222-4222-8222-222222222222.jpg'),
  1,
  'circle owner can delete the helper''s photo'
);

-- 8. A helper who leaves the circle loses access to its photos at once, even to one they uploaded.
select pg_temp.as_user('cc4a0002-0000-4000-8000-000000000002'::uuid);
insert into storage.objects (id, bucket_id, name, owner, owner_id)
values (
  'cc4af00d-0000-4000-8000-00000000000d'::uuid,
  'prescription-photos',
  'cc4ac001-0000-4000-8000-000000000001/dddddddd-dddd-4ddd-8ddd-dddddddddddd.jpg',
  'cc4a0002-0000-4000-8000-000000000002'::uuid,
  'cc4a0002-0000-4000-8000-000000000002'
);

set local role postgres;
delete from public.circle_members
 where circle_id = 'cc4ac001-0000-4000-8000-000000000001'::uuid
   and user_id = 'cc4a0002-0000-4000-8000-000000000002'::uuid;

select pg_temp.as_user('cc4a0002-0000-4000-8000-000000000002'::uuid);
select is(
  (select count(*)::int from storage.objects where bucket_id = 'prescription-photos'),
  0,
  'a former helper sees 0 photos, including the one they uploaded'
);
select is(
  pg_temp.api_delete('cc4ac001-0000-4000-8000-000000000001/dddddddd-dddd-4ddd-8ddd-dddddddddddd.jpg'),
  0,
  'a former helper cannot delete the photo they uploaded'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner)
    values (
      'prescription-photos',
      'cc4ac001-0000-4000-8000-000000000001/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.jpg',
      'cc4a0002-0000-4000-8000-000000000002'::uuid
    )$$,
  '42501',
  null,
  'a former helper is refused upload'
);

-- 9. Scheduled 24-hour clean-up: the database lists, the Edge Function deletes through the Storage API.
set local role postgres;

insert into storage.buckets (id, name, public)
values ('other-bucket-for-cleanup-test', 'other-bucket-for-cleanup-test', false)
on conflict (id) do nothing;

insert into storage.objects (id, bucket_id, name, owner, created_at)
values
  (
    'cc4af003-0000-4000-8000-000000000003'::uuid,
    'prescription-photos',
    'cc4ac001-0000-4000-8000-000000000001/77777777-7777-4777-8777-777777777777.jpg',
    'cc4a0001-0000-4000-8000-000000000001'::uuid,
    now() - interval '24 hours 1 minute'
  ),
  (
    'cc4af006-0000-4000-8000-000000000006'::uuid,
    'prescription-photos',
    'cc4ac002-0000-4000-8000-000000000002/99999999-9999-4999-8999-999999999999.jpg',
    'cc4a0004-0000-4000-8000-000000000004'::uuid,
    now() - interval '3 days'
  ),
  (
    'cc4af004-0000-4000-8000-000000000004'::uuid,
    'prescription-photos',
    'cc4ac001-0000-4000-8000-000000000001/88888888-8888-4888-8888-888888888888.jpg',
    'cc4a0001-0000-4000-8000-000000000001'::uuid,
    now() - interval '23 hours 50 minutes'
  ),
  (
    'cc4af005-0000-4000-8000-000000000005'::uuid,
    'other-bucket-for-cleanup-test',
    'keep-me.txt',
    'cc4a0001-0000-4000-8000-000000000001'::uuid,
    now() - interval '48 hours'
  );

-- App roles cannot run the server clean-up list
select pg_temp.as_user('cc4a0001-0000-4000-8000-000000000001'::uuid);
select throws_ok(
  $$select * from public.list_expired_prescription_photos()$$,
  '42501',
  null,
  'authenticated role cannot execute public.list_expired_prescription_photos()'
);

select pg_temp.as_anon();
select throws_ok(
  $$select * from public.list_expired_prescription_photos()$$,
  '42501',
  null,
  'anon role cannot execute public.list_expired_prescription_photos()'
);

set local role service_role;
select results_eq(
  $$select * from public.list_expired_prescription_photos()$$,
  $$values
    ('cc4ac002-0000-4000-8000-000000000002/99999999-9999-4999-8999-999999999999.jpg'::text),
    ('cc4ac001-0000-4000-8000-000000000001/77777777-7777-4777-8777-777777777777.jpg'::text)$$,
  'service_role gets every prescription photo older than 24 hours, from every circle, oldest first; nothing newer, nothing from other buckets'
);

select results_eq(
  $$select * from public.list_expired_prescription_photos(1)$$,
  $$values ('cc4ac002-0000-4000-8000-000000000002/99999999-9999-4999-8999-999999999999.jpg'::text)$$,
  'list_expired_prescription_photos(p_limit) returns at most p_limit names (oldest first)'
);

set local role postgres;
select is(
  (select count(*)::int from storage.objects
    where id in (
      'cc4af003-0000-4000-8000-000000000003'::uuid,
      'cc4af004-0000-4000-8000-000000000004'::uuid,
      'cc4af005-0000-4000-8000-000000000005'::uuid,
      'cc4af006-0000-4000-8000-000000000006'::uuid
    )),
  4,
  'listing deletes nothing in SQL (the Storage API deletes the files)'
);

select * from finish();

rollback;
