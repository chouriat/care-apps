-- CC-11 [safety 1/2]: pgTAP tests for explicit health-data consent (GDPR Art. 9(2)(a)).
--
-- Proposed contract for CC-11 [safety 2/2]:
-- 1. Column `public.users_profile.health_consent_at timestamptz` (nullable, default NULL).
--    Users cannot write it directly (`grant update (display_name, locale, timezone)` on
--    `public.users_profile` stays unchanged; `health_consent_at` is NOT granted for direct UPDATE).
-- 2. RPC `public.give_health_consent() returns timestamptz` (`SECURITY DEFINER`, `set search_path = ''`):
--    - Sets `health_consent_at = pg_catalog.now()` on `public.users_profile` for `auth.uid()` only.
--    - Refuses `anon` (no EXECUTE privilege) and unauthenticated callers (`auth.uid() is null` -> `42501`).
--    - Idempotent: calling `give_health_consent()` again when `health_consent_at` is already non-null
--      keeps and returns the first timestamp (`coalesce(health_consent_at, pg_catalog.now())`).
-- 3. `public.create_circle` and `public.accept_invite`:
--    - Refuse a signed-in caller whose `public.users_profile.health_consent_at is null` with
--      SQLSTATE `P0001` and message `CONSENT_REQUIRED` BEFORE any other validation, invite-token,
--      circle-ownership, or plan/seat-limit check, writing nothing to `circles`, `circle_members`,
--      or `invites`.
-- 4. Existing circle members (created before CC-11 with `health_consent_at is null`) are NOT
--    locked out of their data:
--    - Chosen approach: RLS read/write policies on existing circles, `public.export_user_data()`,
--      and `public.delete_own_account()` are NOT gated on `health_consent_at`; only `create_circle`
--      and `accept_invite` require consent, and the migration does NOT backfill `health_consent_at`
--      (so the database never fabricates a GDPR Art. 9 consent timestamp for someone who did not
--      actively tick the consent box).
-- 5. `public.export_user_data()` includes `profile.health_consent_at`, and `public.delete_own_account()`
--    continues to work both with and without consent.

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

-- Dynamic helpers so all 24 pgTAP checks execute cleanly even before the CC-11 migration exists on main.
create or replace function pg_temp.read_consent_iso(p_user_id uuid)
returns text
language plpgsql
as $$
declare
  v_ts timestamptz;
begin
  execute 'select health_consent_at from public.users_profile where user_id = $1'
    into v_ts using p_user_id;
  return coalesce(to_char(v_ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'NULL');
exception
  when others then
    return 'ERROR ' || sqlstate || ': ' || sqlerrm;
end;
$$;

create or replace function pg_temp.try_direct_update_consent(p_user_id uuid)
returns text
language plpgsql
as $$
begin
  execute 'update public.users_profile set health_consent_at = now() where user_id = $1'
    using p_user_id;
  return 'UPDATED';
exception
  when others then
    return 'ERROR ' || sqlstate || ': ' || sqlerrm;
end;
$$;

create or replace function pg_temp.set_consent_as_postgres(p_user_id uuid, p_ts timestamptz)
returns text
language plpgsql
as $$
begin
  execute 'update public.users_profile set health_consent_at = $2 where user_id = $1'
    using p_user_id, p_ts;
  return 'OK';
exception
  when others then
    return 'ERROR ' || sqlstate || ': ' || sqlerrm;
end;
$$;

create or replace function pg_temp.call_give_consent()
returns text
language plpgsql
as $$
declare
  v_ts timestamptz;
begin
  execute 'select public.give_health_consent()' into v_ts;
  return coalesce(to_char(v_ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'NULL');
exception
  when others then
    return 'ERROR ' || sqlstate || ': ' || sqlerrm;
end;
$$;

create or replace function pg_temp.call_create_circle(
  p_name text,
  p_recipient text,
  p_tz text
)
returns text
language plpgsql
as $$
declare
  r record;
begin
  select * into r from public.create_circle(p_name, p_recipient, p_tz);
  return 'OK:' || r.name || ':' || r.care_recipient_name || ':' || r.timezone;
exception
  when others then
    return 'ERROR ' || sqlstate || ': ' || sqlerrm;
end;
$$;

create or replace function pg_temp.call_accept_invite(p_token text)
returns text
language plpgsql
as $$
declare
  v_res jsonb;
begin
  v_res := public.accept_invite(p_token);
  return 'OK:' || coalesce(v_res->>'role', 'null');
exception
  when others then
    return 'ERROR ' || sqlstate || ': ' || sqlerrm;
end;
$$;

grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- 1-2. Column existence, type, nullability, and column-level UPDATE privilege
select is(
  (select data_type || '/' || is_nullable || '/' || coalesce(column_default, 'NONE')
     from information_schema.columns
    where table_schema = 'public'
      and table_name = 'users_profile'
      and column_name = 'health_consent_at'),
  'timestamp with time zone/YES/NONE',
  '1. public.users_profile.health_consent_at exists as nullable timestamptz with NULL default'
);

select is(
  (select case
     when exists (
       select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'users_profile'
          and column_name = 'health_consent_at'
     )
     then has_column_privilege('authenticated', 'public.users_profile', 'health_consent_at', 'UPDATE')
     else null
   end),
  false,
  '2. authenticated role does not have direct UPDATE privilege on users_profile.health_consent_at'
);

-- Seed users u01..u06:
-- u01: gives consent, tests idempotency and export_user_data
-- u02: attempts create_circle without consent, then gives consent, creates circle, deletes account
-- u03: attempts accept_invite without consent, then gives consent, accepts invite
-- u04: owner of an existing circle with a valid invite and a full 2-seat free circle
-- u05: pre-CC-11 owner of an existing circle with health_consent_at = NULL
-- u06: pre-CC-11 helper in u05's circle with health_consent_at = NULL (tests reads, export, delete)
select pg_temp.as_postgres();

insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select ('cc11000' || n::text || '-0000-4000-8000-00000000000' || n::text)::uuid,
       '00000000-0000-0000-0000-000000000000'::uuid,
       'authenticated',
       'authenticated',
       'cc11-user-' || n::text || '@example.test',
       '{}'::jsonb,
       '{}'::jsonb,
       now(),
       now()
  from generate_series(1, 6) as n;

-- Pre-seed existing circles (simulating circles created before CC-11 deployed):
-- Circle 1 (owned by u04, open seat on Free plan with valid invite token 'cc11-open-invite-token-0001')
-- Circle 2 (owned by u05 with helper u06 -> full 2-seat Free circle, valid invite token 'cc11-full-invite-token-0002', plus 1 medication)
insert into public.circles (id, name, care_recipient_name, timezone, created_by)
values
  ('cc11c001-0000-4000-8000-000000000001'::uuid, 'Open Circle', 'Evelyn', 'Europe/Paris', 'cc110004-0000-4000-8000-000000000004'::uuid),
  ('cc11c002-0000-4000-8000-000000000002'::uuid, 'Legacy Full Circle', 'Arthur', 'Europe/London', 'cc110005-0000-4000-8000-000000000005'::uuid);

insert into public.circle_members (circle_id, user_id, role)
values
  ('cc11c001-0000-4000-8000-000000000001'::uuid, 'cc110004-0000-4000-8000-000000000004'::uuid, 'owner'),
  ('cc11c002-0000-4000-8000-000000000002'::uuid, 'cc110005-0000-4000-8000-000000000005'::uuid, 'owner'),
  ('cc11c002-0000-4000-8000-000000000002'::uuid, 'cc110006-0000-4000-8000-000000000006'::uuid, 'helper');

insert into public.invites (id, circle_id, token, role, expires_at)
values
  ('cc11a001-0000-4000-8000-000000000001'::uuid, 'cc11c001-0000-4000-8000-000000000001'::uuid, 'cc11-open-invite-token-0001', 'helper', now() + interval '7 days'),
  ('cc11a002-0000-4000-8000-000000000002'::uuid, 'cc11c002-0000-4000-8000-000000000002'::uuid, 'cc11-full-invite-token-0002', 'helper', now() + interval '7 days');

insert into public.medications (id, circle_id, name, strength, dose_text, schedule, start_date, active, source)
values (
  'cc11b001-0000-4000-8000-000000000001'::uuid,
  'cc11c002-0000-4000-8000-000000000002'::uuid,
  'Metformin',
  '500 mg',
  '1 tablet',
  '{"kind":"daily","times":["08:00"]}'::jsonb,
  current_date - 3,
  true,
  'manual'
);

-- 3-4. Default NULL after sign-up, and direct UPDATE by authenticated user refused with 42501
select is(
  pg_temp.read_consent_iso('cc110001-0000-4000-8000-000000000001'::uuid),
  'NULL',
  '3. newly signed-up user starts with users_profile.health_consent_at = NULL'
);

select pg_temp.as_user('cc110001-0000-4000-8000-000000000001'::uuid);
select set_config(
  'cc11.direct_upd',
  pg_temp.try_direct_update_consent('cc110001-0000-4000-8000-000000000001'::uuid),
  true
);
select pg_temp.as_postgres();
select matches(
  current_setting('cc11.direct_upd') || ' / stored=' || pg_temp.read_consent_iso('cc110001-0000-4000-8000-000000000001'::uuid),
  '^ERROR 42501: .* / stored=NULL$',
  '4. signed-in user direct UPDATE of health_consent_at fails with 42501 and leaves NULL'
);

-- 5-10. public.give_health_consent() metadata, privileges, and unauthenticated refusal
select is(
  (select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'give_health_consent'),
  true,
  '5. public.give_health_consent is SECURITY DEFINER'
);

select is(
  (select pg_get_function_identity_arguments(p.oid) || ' -> ' || pg_get_function_result(p.oid)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'give_health_consent'),
  ' -> timestamp with time zone',
  '6. public.give_health_consent signature is () returning timestamptz'
);

select is(
  (select coalesce(p.proconfig, '{}'::text[]) @> array['search_path=""']
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'give_health_consent'),
  true,
  '7. public.give_health_consent pins search_path to an empty string'
);

select is(
  (select bool_or(has_function_privilege('anon', p.oid, 'EXECUTE'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'give_health_consent'),
  false,
  '8. anon role cannot execute public.give_health_consent'
);

select is(
  (select bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'give_health_consent'),
  true,
  '9. authenticated role can execute public.give_health_consent'
);

select pg_temp.as_user('cc110001-0000-4000-8000-000000000001'::uuid);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select matches(
  pg_temp.call_give_consent(),
  '^ERROR 42501:',
  '10. give_health_consent refuses an unauthenticated caller (null auth.uid()) with 42501'
);

-- 11-12. give_health_consent sets health_consent_at = now() for auth.uid() only, and keeps the first time on repeat calls
select pg_temp.as_user('cc110001-0000-4000-8000-000000000001'::uuid);
-- Separate statements so subsequent reads see the updated row snapshot.
select set_config('cc11.u01_first', pg_temp.call_give_consent(), true);
select pg_temp.as_postgres();

select is(
  current_setting('cc11.u01_first')
    || '/' || pg_temp.read_consent_iso('cc110001-0000-4000-8000-000000000001'::uuid)
    || '/' || pg_temp.read_consent_iso('cc110002-0000-4000-8000-000000000002'::uuid),
  to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    || '/' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    || '/NULL',
  '11. give_health_consent sets health_consent_at = now() for auth.uid() only and leaves other users NULL'
);

-- Backdate u01's consent to 2 hours ago as postgres, then call give_health_consent() again as u01:
-- must preserve and return the original timestamp (now() - 2 hours), not overwrite with now().
select pg_temp.set_consent_as_postgres(
  'cc110001-0000-4000-8000-000000000001'::uuid,
  now() - interval '2 hours'
);
select pg_temp.as_user('cc110001-0000-4000-8000-000000000001'::uuid);
select set_config('cc11.u01_repeat', pg_temp.call_give_consent(), true);
select pg_temp.as_postgres();

select is(
  current_setting('cc11.u01_repeat')
    || '/' || pg_temp.read_consent_iso('cc110001-0000-4000-8000-000000000001'::uuid),
  to_char((now() - interval '2 hours') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    || '/' || to_char((now() - interval '2 hours') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  '12. calling give_health_consent again preserves and returns the first consent timestamp'
);

-- 13-18. create_circle and accept_invite refuse callers without consent (P0001 CONSENT_REQUIRED) BEFORE other checks, writing nothing
select pg_temp.as_user('cc110002-0000-4000-8000-000000000002'::uuid);
select set_config(
  'cc11.create_no_consent',
  pg_temp.call_create_circle('New Circle', 'Nadia', 'Europe/Paris'),
  true
);
select is(
  current_setting('cc11.create_no_consent'),
  'ERROR P0001: CONSENT_REQUIRED',
  '13. create_circle without health consent fails with P0001 CONSENT_REQUIRED'
);

-- u05 already owns Legacy Full Circle and passes invalid blank arguments, yet has health_consent_at = NULL:
-- CONSENT_REQUIRED must fire BEFORE validation (22023) and BEFORE CIRCLE_LIMIT_REACHED.
select pg_temp.as_user('cc110005-0000-4000-8000-000000000005'::uuid);
select set_config(
  'cc11.create_order',
  pg_temp.call_create_circle('   ', '   ', 'Invalid/Zone'),
  true
);
select is(
  current_setting('cc11.create_order'),
  'ERROR P0001: CONSENT_REQUIRED',
  '14. create_circle checks CONSENT_REQUIRED before validation and CIRCLE_LIMIT_REACHED'
);

select pg_temp.as_postgres();
select is(
  (select count(*)::int from public.circles) || '/' || (select count(*)::int from public.circle_members),
  '2/3',
  '15. refused create_circle calls without consent write no circles or circle_members rows'
);

select pg_temp.as_user('cc110003-0000-4000-8000-000000000003'::uuid);
select set_config(
  'cc11.accept_no_consent',
  pg_temp.call_accept_invite('cc11-open-invite-token-0001'),
  true
);
select is(
  current_setting('cc11.accept_no_consent'),
  'ERROR P0001: CONSENT_REQUIRED',
  '16. accept_invite without health consent fails with P0001 CONSENT_REQUIRED'
);

-- On the full 2-member free circle (would otherwise fail with CIRCLE_LIMIT_REACHED / CIRCLE_FULL),
-- u03 without consent must receive CONSENT_REQUIRED first.
select set_config(
  'cc11.accept_order',
  pg_temp.call_accept_invite('cc11-full-invite-token-0002'),
  true
);
select is(
  current_setting('cc11.accept_order'),
  'ERROR P0001: CONSENT_REQUIRED',
  '17. accept_invite checks CONSENT_REQUIRED before plan and member-limit checks'
);

select pg_temp.as_postgres();
select is(
  (select count(*)::int from public.circle_members)
    || '/' ||
  (select count(*)::int from public.invites where used_by is not null),
  '3/0',
  '18. refused accept_invite calls without consent write no circle_members rows and consume no invites'
);

-- 19-20. After give_health_consent(), create_circle and accept_invite work as before
select pg_temp.as_user('cc110002-0000-4000-8000-000000000002'::uuid);
select set_config('cc11.u02_consent', pg_temp.call_give_consent(), true);
select set_config(
  'cc11.u02_create',
  pg_temp.call_create_circle('Consent Circle', 'Nadia', 'Europe/Paris'),
  true
);
select pg_temp.as_postgres();
select is(
  current_setting('cc11.u02_create')
    || '/circles=' || (select count(*)::int from public.circles where created_by = 'cc110002-0000-4000-8000-000000000002'::uuid)::text,
  'OK:Consent Circle:Nadia:Europe/Paris/circles=1',
  '19. after give_health_consent, create_circle succeeds and writes the circle and owner membership'
);

select pg_temp.as_user('cc110003-0000-4000-8000-000000000003'::uuid);
select set_config('cc11.u03_consent', pg_temp.call_give_consent(), true);
select set_config(
  'cc11.u03_accept',
  pg_temp.call_accept_invite('cc11-open-invite-token-0001'),
  true
);
select pg_temp.as_postgres();
select is(
  current_setting('cc11.u03_accept')
    || '/used_by=' || coalesce((select used_by::text from public.invites where id = 'cc11a001-0000-4000-8000-000000000001'::uuid), 'NULL'),
  'OK:helper/used_by=cc110003-0000-4000-8000-000000000003',
  '20. after give_health_consent, accept_invite succeeds and marks the invite used_by'
);

-- 21. Pre-existing circle members with health_consent_at = NULL are NOT locked out of reading their circle data
select pg_temp.as_user('cc110006-0000-4000-8000-000000000006'::uuid);
select is(
  (select count(*)::int from public.circles where id = 'cc11c002-0000-4000-8000-000000000002'::uuid)
    || '/' ||
  (select count(*)::int from public.medications where circle_id = 'cc11c002-0000-4000-8000-000000000002'::uuid),
  '1/1',
  '21. existing circle member with health_consent_at = NULL can still read their circle and medications'
);

-- 22-24. export_user_data includes health_consent_at, and delete_own_account still works with and without consent
select pg_temp.as_user('cc110001-0000-4000-8000-000000000001'::uuid);
select set_config(
  'cc11.u01_export_has_key',
  ((public.export_user_data()->'profile') ? 'health_consent_at')::text,
  true
);
select set_config(
  'cc11.u01_export_non_null',
  ((public.export_user_data()->'profile'->>'health_consent_at') is not null)::text,
  true
);
select pg_temp.as_user('cc110006-0000-4000-8000-000000000006'::uuid);
select set_config(
  'cc11.u06_export_has_key',
  ((public.export_user_data()->'profile') ? 'health_consent_at')::text,
  true
);
select set_config(
  'cc11.u06_export_is_null',
  ((public.export_user_data()->'profile'->>'health_consent_at') is null)::text,
  true
);
select is(
  current_setting('cc11.u01_export_has_key')
    || '/' || current_setting('cc11.u01_export_non_null')
    || '/' || current_setting('cc11.u06_export_has_key')
    || '/' || current_setting('cc11.u06_export_is_null'),
  'true/true/true/true',
  '22. export_user_data includes profile.health_consent_at (timestamp when given, JSON null when not given)'
);

select pg_temp.as_user('cc110002-0000-4000-8000-000000000002'::uuid);
select set_config('cc11.u02_del', (public.delete_own_account()->>'ok'), true);
select pg_temp.as_postgres();
select is(
  current_setting('cc11.u02_del')
    || '/left=' || (select count(*)::int from auth.users where id = 'cc110002-0000-4000-8000-000000000002'::uuid)::text,
  'true/left=0',
  '23. delete_own_account succeeds for a consented solo circle owner'
);

select pg_temp.as_user('cc110006-0000-4000-8000-000000000006'::uuid);
select set_config('cc11.u06_del', (public.delete_own_account()->>'ok'), true);
select pg_temp.as_postgres();
select is(
  current_setting('cc11.u06_del')
    || '/left=' || (select count(*)::int from auth.users where id = 'cc110006-0000-4000-8000-000000000006'::uuid)::text,
  'true/left=0',
  '24. delete_own_account succeeds for an unconsented existing circle helper'
);

select * from finish();

rollback;
