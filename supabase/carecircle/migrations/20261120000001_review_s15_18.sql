-- Claude's combined review of batch/s15-18 (20 Nov 2026). Never edit a merged migration, so the
-- fixes to CC-8 and CC-10 functions are new definitions here.

-- 1. circle_has_family_plan: the membership check never ran. Inside a SECURITY DEFINER function
--    current_user is the function's owner (postgres), so `current_user not in ('postgres',
--    'service_role')` was always false and any signed-in user could ask about any circle id.
--    A membership check cannot simply be added: accept_invite asks this question for the person
--    who is joining, who is not a member yet. Nothing in the app calls this function directly, so
--    signed-in users may no longer call it at all; accept_invite (SECURITY DEFINER, runs as the
--    owner) and the service role still can.
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

revoke all on function public.circle_has_family_plan(uuid) from public, anon, authenticated;
grant execute on function public.circle_has_family_plan(uuid) to service_role;

-- 2. transfer_ownership: same as 20261116000006, plus the 1-circle rule for the new owner.
create or replace function public.transfer_ownership(
  "circleId" uuid,
  "newOwnerId" uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  v_user_id := (select auth.uid());
  if v_user_id is null then
    raise exception 'Authentication required to transfer ownership'
      using errcode = '42501';
  end if;

  if "circleId" is null or not public.has_circle_role("circleId", array['owner'::public.member_role]) then
    raise exception 'Only the circle owner can transfer ownership'
      using errcode = '42501';
  end if;

  if "newOwnerId" is null or not exists (
    select 1
      from public.circle_members cm
     where cm.circle_id = "circleId"
       and cm.user_id = "newOwnerId"
  ) then
    raise exception 'New owner must be a current member of the circle'
      using errcode = '22023';
  end if;

  perform 1
     from public.circles c
    where c.id = "circleId"
      for update;

  -- Spec "Roles and permissions": 1 circle per person (Taha, 2026-11-17: one circle you own).
  -- Same rule and error as create_circle, so a transfer cannot give someone a second owned circle.
  if "newOwnerId" <> v_user_id and exists (
    select 1
      from public.circle_members cm
     where cm.user_id = "newOwnerId"
       and cm.role = 'owner'::public.member_role
       and cm.circle_id <> "circleId"
  ) then
    raise exception 'CIRCLE_LIMIT_REACHED'
      using errcode = 'P0001';
  end if;

  if "newOwnerId" <> v_user_id then
    perform pg_catalog.set_config('carecircle.in_transfer_ownership', '1', true);

    update public.circle_members
       set role = 'helper'::public.member_role
     where circle_id = "circleId"
       and user_id = v_user_id;

    update public.circle_members
       set role = 'owner'::public.member_role
     where circle_id = "circleId"
       and user_id = "newOwnerId";

    perform pg_catalog.set_config('carecircle.in_transfer_ownership', '', true);
  end if;

  return pg_catalog.jsonb_build_object(
    'circleId', "circleId",
    'newOwnerId', "newOwnerId"
  );
end;
$$;

revoke all on function public.transfer_ownership(uuid, uuid) from public, anon;
grant execute on function public.transfer_ownership(uuid, uuid) to authenticated, service_role;

-- 3. delete_own_account: same as 20261116000006 without the SQL delete from storage.objects.
create or replace function public.delete_own_account(
  p_target_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller_uid uuid;
  v_user_id uuid;
  v_solo_circle_ids uuid[];
  v_solo_circle_texts text[];
begin
  v_caller_uid := (select auth.uid());
  if v_caller_uid is not null then
    if p_target_user_id is not null and p_target_user_id <> v_caller_uid then
      raise exception 'Cannot delete another user account'
        using errcode = '42501';
    end if;
    v_user_id := v_caller_uid;
  -- Inside SECURITY DEFINER current_user is always the owner, so ask who really called: the
  -- service role (the delete-account Edge Function) or a database session (tests, SQL editor).
  elsif (
      coalesce((select auth.jwt()) ->> 'role', '') = 'service_role'
      or session_user = 'postgres'
    ) and p_target_user_id is not null then
    v_user_id := p_target_user_id;
  else
    raise exception 'Authentication required to delete account'
      using errcode = '42501';
  end if;

  if not exists (select 1 from auth.users where id = v_user_id) then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'deletedCircleIds', '[]'::jsonb
    );
  end if;

  -- Refuse if the user owns any circle that has other members
  if exists (
    select 1
      from public.circle_members cm_owner
     where cm_owner.user_id = v_user_id
       and cm_owner.role = 'owner'::public.member_role
       and exists (
         select 1
           from public.circle_members cm_other
          where cm_other.circle_id = cm_owner.circle_id
            and cm_other.user_id <> v_user_id
       )
  ) then
    raise exception 'OWNER_MUST_TRANSFER'
      using errcode = 'P0001';
  end if;

  -- Find all circles where this user is the sole member (and owner)
  select coalesce(pg_catalog.array_agg(cm.circle_id), array[]::uuid[]),
         coalesce(pg_catalog.array_agg(cm.circle_id::text), array[]::text[])
    into v_solo_circle_ids, v_solo_circle_texts
    from public.circle_members cm
   where cm.user_id = v_user_id
     and cm.role = 'owner'::public.member_role;

  -- Delete solo-owned circles first so all child rows (medications, doses, appointments,
  -- tasks, visit_notes, invites, circle_members, log_entries) cascade-delete cleanly.
  if coalesce(pg_catalog.array_length(v_solo_circle_ids, 1), 0) > 0 then
    delete from public.circles
     where id = any(v_solo_circle_ids);
  end if;

  -- Storage files are NOT deleted here. Supabase Storage keeps the files themselves outside the
  -- database; deleting `storage.objects` rows with SQL leaves the files behind with nothing pointing
  -- at them (and newer Storage versions refuse such deletes). The `delete-account` Edge Function
  -- deletes the solo circles' files through the Storage API after this function succeeds, and the
  -- daily clean-up removes anything left in these short-lived buckets within 24 hours.

  -- Delete the auth.users row (cascades to users_profile, circle_members, push_tokens,
  -- entitlements, ai_calls, and sets nullable user foreign keys to null).
  delete from auth.users
   where id = v_user_id;

  -- Clear any remaining member ref_id references in surviving circles' log_entries
  update public.log_entries
     set ref_id = null
   where ref_id = v_user_id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'deletedCircleIds', pg_catalog.to_jsonb(v_solo_circle_ids)
  );
end;
$$;

revoke all on function public.delete_own_account(uuid) from public, anon;
grant execute on function public.delete_own_account(uuid) to authenticated, service_role;
