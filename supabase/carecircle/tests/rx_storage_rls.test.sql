-- CC-4a pre-work [safety 1/2]: Prescription photos Storage bucket, RLS policies, and 24h clean-up.
-- Rules (decided 2026-11-15):
-- 1. Private bucket `prescription-photos` (`public = false`), `image/jpeg` only (`allowed_mime_types = array['image/jpeg']`),
--    2 MB limit (`file_size_limit = 2097152`), path `<circle_id>/<uuid>.jpg`.
-- 2. Storage policies on `storage.objects`: only `owner` and `helper` of `<circle_id>` in the path
--    can `INSERT`, `SELECT`, and `DELETE`. Viewers, other families' owners/helpers, outsiders, and `anon`
--    get nothing. No `UPDATE` for anyone (a retake is a new upload).
-- 3. Scheduled clean-up `public.delete_expired_prescription_photos()` deletes every object in
--    `prescription-photos` older than 24 hours (`created_at < now() - interval '24 hours'`), leaving
--    newer objects and other buckets untouched.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, storage, extensions;

select plan(26);

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
-- Circle A: owner_a, helper_a, viewer_a
-- Circle B: owner_b
-- Outsider: belongs to no circle
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('cc4a0001-0000-4000-8000-000000000001'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'owner-a@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('cc4a0002-0000-4000-8000-000000000002'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'helper-a@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('cc4a0003-0000-4000-8000-000000000003'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'viewer-a@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('cc4a0004-0000-4000-8000-000000000004'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'owner-b@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('cc4a0005-0000-4000-8000-000000000005'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated', 'outsider@example.test', '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.circles (id, name, care_recipient_name, timezone, created_by)
values
  ('cc4ac001-0000-4000-8000-000000000001'::uuid, 'Family A', 'Alice', 'Europe/Paris', 'cc4a0001-0000-4000-8000-000000000001'::uuid),
  ('cc4ac002-0000-4000-8000-000000000002'::uuid, 'Family B', 'Bob', 'Europe/Paris', 'cc4a0004-0000-4000-8000-000000000004'::uuid);

insert into public.circle_members (circle_id, user_id, role)
values
  ('cc4ac001-0000-4000-8000-000000000001'::uuid, 'cc4a0001-0000-4000-8000-000000000001'::uuid, 'owner'),
  ('cc4ac001-0000-4000-8000-000000000001'::uuid, 'cc4a0002-0000-4000-8000-000000000002'::uuid, 'helper'),
  ('cc4ac001-0000-4000-8000-000000000001'::uuid, 'cc4a0003-0000-4000-8000-000000000003'::uuid, 'viewer'),
  ('cc4ac002-0000-4000-8000-000000000002'::uuid, 'cc4a0004-0000-4000-8000-000000000004'::uuid, 'owner');

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

-- 3. Upload (INSERT) refused for viewer, another family's owner, outsider, and anon
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

-- 4. Path pattern enforcement on INSERT (<circle_id>/<uuid>.jpg only)
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

-- 5. Read (SELECT): only owner and helper of Circle A can read Circle A's photos
select pg_temp.as_user('cc4a0001-0000-4000-8000-000000000001'::uuid);
select is(
  (select count(*)::int from storage.objects where bucket_id = 'prescription-photos'),
  2,
  'circle owner can read all prescription photos in their circle'
);

select pg_temp.as_user('cc4a0002-0000-4000-8000-000000000002'::uuid);
select is(
  (select count(*)::int from storage.objects where bucket_id = 'prescription-photos'),
  2,
  'circle helper can read all prescription photos in their circle'
);

select pg_temp.as_user('cc4a0003-0000-4000-8000-000000000003'::uuid);
select is(
  (select count(*)::int from storage.objects where bucket_id = 'prescription-photos'),
  0,
  'circle viewer sees 0 prescription photos'
);

select pg_temp.as_user('cc4a0004-0000-4000-8000-000000000004'::uuid);
select is(
  (select count(*)::int from storage.objects where bucket_id = 'prescription-photos'),
  0,
  'another family''s owner sees 0 prescription photos from Circle A'
);

select pg_temp.as_anon();
select is(
  (select count(*)::int from storage.objects where bucket_id = 'prescription-photos'),
  0,
  'anonymous caller sees 0 prescription photos'
);

-- 6. No UPDATE allowed on prescription-photos (a retake is a new upload)
select pg_temp.as_user('cc4a0001-0000-4000-8000-000000000001'::uuid);
update storage.objects
   set metadata = '{"mimetype":"image/jpeg","size":999}'::jsonb
 where id = 'cc4af001-0000-4000-8000-000000000001'::uuid;

set local role postgres;
select is(
  (select (metadata->>'size')::int from storage.objects where id = 'cc4af001-0000-4000-8000-000000000001'::uuid),
  120000,
  'circle owner cannot update an existing prescription photo (retake must be a new upload)'
);

-- 7. Delete (DELETE): viewer and other family's owner cannot delete; owner and helper can delete
select pg_temp.as_user('cc4a0003-0000-4000-8000-000000000003'::uuid);
delete from storage.objects where id = 'cc4af001-0000-4000-8000-000000000001'::uuid;

select pg_temp.as_user('cc4a0004-0000-4000-8000-000000000004'::uuid);
delete from storage.objects where id = 'cc4af001-0000-4000-8000-000000000001'::uuid;

set local role postgres;
select is(
  (select count(*)::int from storage.objects where bucket_id = 'prescription-photos'),
  2,
  'viewer and other family''s owner cannot delete Circle A''s prescription photos'
);

select pg_temp.as_user('cc4a0002-0000-4000-8000-000000000002'::uuid);
delete from storage.objects where id = 'cc4af001-0000-4000-8000-000000000001'::uuid;

set local role postgres;
select is(
  (select count(*)::int from storage.objects where id = 'cc4af001-0000-4000-8000-000000000001'::uuid),
  0,
  'circle helper can delete a prescription photo in their circle when medicine is saved or draft is discarded'
);

select pg_temp.as_user('cc4a0001-0000-4000-8000-000000000001'::uuid);
delete from storage.objects where id = 'cc4af002-0000-4000-8000-000000000002'::uuid;

set local role postgres;
select is(
  (select count(*)::int from storage.objects where id = 'cc4af002-0000-4000-8000-000000000002'::uuid),
  0,
  'circle owner can delete a prescription photo in their circle'
);

-- 8. Scheduled 24-hour clean-up (`public.delete_expired_prescription_photos()`)
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

-- App roles cannot execute the server cleanup function directly
select pg_temp.as_user('cc4a0001-0000-4000-8000-000000000001'::uuid);
select throws_ok(
  $$select public.delete_expired_prescription_photos()$$,
  '42501',
  null,
  'authenticated role cannot execute public.delete_expired_prescription_photos() directly'
);

select pg_temp.as_anon();
select throws_ok(
  $$select public.delete_expired_prescription_photos()$$,
  '42501',
  null,
  'anon role cannot execute public.delete_expired_prescription_photos() directly'
);

set local role postgres;
select is(
  public.delete_expired_prescription_photos(),
  1,
  'delete_expired_prescription_photos() deletes 1 expired photo older than 24 hours'
);

select is(
  (select count(*)::int from storage.objects where id = 'cc4af003-0000-4000-8000-000000000003'::uuid),
  0,
  'photo older than 24 hours is deleted from prescription-photos'
);

select is(
  (select count(*)::int from storage.objects
    where id in ('cc4af004-0000-4000-8000-000000000004'::uuid, 'cc4af005-0000-4000-8000-000000000005'::uuid)),
  2,
  'photo newer than 24 hours and objects in other buckets are untouched by cleanup'
);

select * from finish();

rollback;
