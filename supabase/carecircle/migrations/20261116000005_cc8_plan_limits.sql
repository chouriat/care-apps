-- CC-8 [safety 2/2]: Server-side Family plan helper `public.circle_has_family_plan(uuid)`
-- and 8-member Family ceiling check on `public.create_invite`.

create or replace function public.circle_has_family_plan(p_circle_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_circle_id is null then
    return false;
  end if;

  if current_user not in ('postgres', 'service_role') and not public.is_circle_member(p_circle_id) then
    return false;
  end if;

  return exists (
    select 1
      from public.circle_members cm
      join public.entitlements e
        on e.user_id = cm.user_id
     where cm.circle_id = p_circle_id
       and cm.role = 'owner'::public.member_role
       and e.entitlement = 'carecircle_family'
       and e.active = true
       and (e.expires_at is null or e.expires_at > pg_catalog.now())
  );
end;
$$;

revoke all on function public.circle_has_family_plan(uuid) from public, anon;
grant execute on function public.circle_has_family_plan(uuid) to authenticated, service_role;

create or replace function public.create_invite(
  "circleId" uuid,
  role public.member_role default 'helper'::public.member_role
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_member_count int;
  v_token text;
  v_expires_at timestamptz;
begin
  v_user_id := (select auth.uid());
  if v_user_id is null then
    raise exception 'Authentication required to create an invite'
      using errcode = '42501';
  end if;

  if "circleId" is null or not public.has_circle_role("circleId", array['owner'::public.member_role]) then
    raise exception 'Only the circle owner can create invites'
      using errcode = '42501';
  end if;

  if role is null or role = 'owner'::public.member_role then
    raise exception 'Invite role must be helper or viewer'
      using errcode = '22023';
  end if;

  select count(*)::int
    into v_member_count
    from public.circle_members cm
   where cm.circle_id = "circleId";

  if v_member_count >= 8 then
    raise exception 'CIRCLE_FULL'
      using errcode = 'P0001';
  end if;

  insert into public.invites (circle_id, role, expires_at)
  values ("circleId", role, pg_catalog.now() + interval '7 days')
  returning token, expires_at into v_token, v_expires_at;

  return pg_catalog.jsonb_build_object(
    'url', 'carecircle://invite/' || v_token,
    'expiresAt', v_expires_at
  );
end;
$$;

revoke all on function public.create_invite(uuid, public.member_role) from public, anon;
grant execute on function public.create_invite(uuid, public.member_role) to authenticated, service_role;

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
