-- CC-11 [safety 2/2]: Explicit health-data consent (GDPR Art. 9(2)(a)).
-- Adds nullable `public.users_profile.health_consent_at` (not client-writable),
-- `public.give_health_consent() returns timestamptz` (keeps first consent timestamp),
-- and enforces `CONSENT_REQUIRED` (`P0001`) first in `public.create_circle` and `public.accept_invite`.

-- 1. Nullable consent timestamp column; never backfilled and never directly writable by authenticated users.
alter table public.users_profile
  add column health_consent_at timestamptz;

revoke update (health_consent_at)
  on table public.users_profile
  from public, anon, authenticated;

-- 2. RPC: `public.give_health_consent() returns timestamptz`
create or replace function public.give_health_consent()
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_consent_at timestamptz;
begin
  v_user_id := (select auth.uid());
  if v_user_id is null then
    raise exception 'Authentication required to record health-data consent'
      using errcode = '42501';
  end if;

  insert into public.users_profile (user_id, health_consent_at)
  values (v_user_id, pg_catalog.now())
  on conflict (user_id) do update
    set health_consent_at = coalesce(public.users_profile.health_consent_at, pg_catalog.now())
  returning health_consent_at into v_consent_at;

  return v_consent_at;
end;
$$;

revoke all on function public.give_health_consent() from public, anon;
grant execute on function public.give_health_consent() to authenticated, service_role;

-- 3. Update `public.create_circle` to require `health_consent_at is not null` before validation and limits.
create or replace function public.create_circle(
  name text,
  "careRecipientName" text default null,
  timezone text default null,
  care_recipient_name text default null,
  care_recipient_dob date default null
)
returns public.circles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_name text;
  v_recipient_name text;
  v_timezone text;
  v_canonical_tz text;
  v_circle public.circles;
begin
  v_user_id := (select auth.uid());
  if v_user_id is null then
    raise exception 'Authentication required to create a circle'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
      from public.users_profile up
     where up.user_id = v_user_id
       and up.health_consent_at is not null
  ) then
    raise exception 'CONSENT_REQUIRED'
      using errcode = 'P0001';
  end if;

  v_name := btrim(coalesce(name, ''));
  v_recipient_name := btrim(coalesce("careRecipientName", care_recipient_name, ''));
  v_timezone := btrim(coalesce(timezone, ''));

  if char_length(v_name) = 0 then
    raise exception 'Circle name must not be empty'
      using errcode = '22023';
  end if;

  if char_length(v_recipient_name) = 0 then
    raise exception 'Care recipient name must not be empty'
      using errcode = '22023';
  end if;

  if char_length(v_timezone) = 0 then
    raise exception 'Timezone must not be empty'
      using errcode = '22023';
  end if;

  select tz.name
    into v_canonical_tz
    from pg_catalog.pg_timezone_names tz
   where lower(tz.name) = lower(v_timezone)
   order by (tz.name = v_timezone) desc
   limit 1;

  if v_canonical_tz is null then
    raise exception 'Timezone must be a valid IANA timezone name'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user_id::text, 0));

  if exists (
    select 1
      from public.circle_members cm
     where cm.user_id = v_user_id
       and cm.role = 'owner'::public.member_role
  ) then
    raise exception 'CIRCLE_LIMIT_REACHED'
      using errcode = 'P0001';
  end if;

  insert into public.circles (
    name,
    care_recipient_name,
    care_recipient_dob,
    timezone,
    created_by
  )
  values (
    v_name,
    v_recipient_name,
    care_recipient_dob,
    v_canonical_tz,
    v_user_id
  )
  returning * into v_circle;

  insert into public.circle_members (
    circle_id,
    user_id,
    role
  )
  values (
    v_circle.id,
    v_user_id,
    'owner'::public.member_role
  );

  return v_circle;
end;
$$;

revoke all on function public.create_circle(text, text, text, text, date) from public, anon;
grant execute on function public.create_circle(text, text, text, text, date) to authenticated, service_role;

-- 4. Update `public.accept_invite` (preserving CC-8 `circle_has_family_plan` and locks) to require
--    `health_consent_at is not null` before token, plan, and seat-limit checks.
create or replace function public.accept_invite(token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_token text;
  v_invite public.invites;
  v_existing_role public.member_role;
  v_has_family_plan boolean;
  v_max_members int;
  v_member_count int;
begin
  v_user_id := (select auth.uid());
  if v_user_id is null then
    raise exception 'Authentication required to accept an invite'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
      from public.users_profile up
     where up.user_id = v_user_id
       and up.health_consent_at is not null
  ) then
    raise exception 'CONSENT_REQUIRED'
      using errcode = 'P0001';
  end if;

  v_token := pg_catalog.btrim(coalesce(token, ''));
  if pg_catalog.char_length(v_token) = 0 then
    raise exception 'INVITE_INVALID'
      using errcode = 'P0001';
  end if;

  select i.*
    into v_invite
    from public.invites i
   where i.token = v_token
     for update;

  if not found then
    raise exception 'INVITE_INVALID'
      using errcode = 'P0001';
  end if;

  if v_invite.used_by is not null then
    raise exception 'INVITE_USED'
      using errcode = 'P0001';
  end if;

  if v_invite.expires_at <= pg_catalog.now() then
    raise exception 'INVITE_EXPIRED'
      using errcode = 'P0001';
  end if;

  -- Serialize concurrent joins to the same circle before counting members.
  perform 1
     from public.circles c
    where c.id = v_invite.circle_id
      for update;

  -- If the caller is already a member of this circle, keep their existing role and leave the invite unused.
  select cm.role
    into v_existing_role
    from public.circle_members cm
   where cm.circle_id = v_invite.circle_id
     and cm.user_id = v_user_id;

  if found then
    return pg_catalog.jsonb_build_object(
      'circleId', v_invite.circle_id,
      'role', v_existing_role
    );
  end if;

  if v_invite.role = 'owner'::public.member_role then
    raise exception 'INVITE_INVALID'
      using errcode = 'P0001';
  end if;

  -- Read the circle owner's active carecircle_family entitlement on the server via shared helper.
  v_has_family_plan := public.circle_has_family_plan(v_invite.circle_id);
  v_max_members := case when v_has_family_plan then 8 else 2 end;

  select count(*)::int
    into v_member_count
    from public.circle_members cm
   where cm.circle_id = v_invite.circle_id;

  if v_member_count >= v_max_members then
    raise exception 'CIRCLE_FULL'
      using errcode = 'P0001';
  end if;

  insert into public.circle_members (circle_id, user_id, role)
  values (v_invite.circle_id, v_user_id, v_invite.role);

  update public.invites
     set used_by = v_user_id,
         expires_at = least(expires_at, pg_catalog.now())
   where id = v_invite.id;

  return pg_catalog.jsonb_build_object(
    'circleId', v_invite.circle_id,
    'role', v_invite.role
  );
end;
$$;

revoke all on function public.accept_invite(text) from public, anon;
grant execute on function public.accept_invite(text) to authenticated, service_role;
