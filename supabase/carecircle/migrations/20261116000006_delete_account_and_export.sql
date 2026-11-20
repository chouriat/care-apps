-- CC-10 [safety 2/2]: Account deletion (`public.delete_own_account`), ownership transfer
-- (`public.transfer_ownership`), and user data export (`public.export_user_data`).

-- 1. Allow `prevent_ownerless_circle()` to demote the old owner ONLY inside `public.transfer_ownership`
create or replace function public.prevent_ownerless_circle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role = 'owner'::public.member_role then
    if tg_op = 'UPDATE' and new.role <> 'owner'::public.member_role then
      if pg_catalog.current_setting('carecircle.in_transfer_ownership', true) = '1' then
        return new;
      end if;
      raise exception 'Cannot demote the circle owner' using errcode = '42501';
    end if;
    if tg_op = 'DELETE' and exists (select 1 from public.circles where id = old.circle_id) then
      raise exception 'Cannot remove the circle owner while the circle exists' using errcode = '42501';
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function public.prevent_ownerless_circle() from public, anon, authenticated;

-- 2. Allow `prevent_log_entries_mutation()` to clear `created_by` and `ref_id` when a user is deleted from `auth.users`
create or replace function public.prevent_log_entries_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.circles where id = old.circle_id) then
    return old;
  end if;

  if tg_op = 'UPDATE'
    and (new.id, new.circle_id, new.type, new.summary, new.created_at)
      is not distinct from (old.id, old.circle_id, old.type, old.summary, old.created_at)
    and (
      (
        old.created_by is not null
        and new.created_by is null
        and not exists (select 1 from auth.users where id = old.created_by)
      )
      or (
        old.ref_id is not null
        and new.ref_id is null
        and not exists (select 1 from auth.users where id = old.ref_id)
      )
    )
    and (new.created_by is null or new.created_by is not distinct from old.created_by)
    and (new.ref_id is null or new.ref_id is not distinct from old.ref_id) then
    return new;
  end if;

  raise exception 'log_entries is append-only and cannot be updated or deleted'
    using errcode = '42501';
end;
$$;

revoke all on function public.prevent_log_entries_mutation() from public, anon, authenticated;

-- 3. Ensure `write_audit_log_entry()` never inserts a deleted user's UUID into `created_by` or `ref_id`
--    during an `auth.users` cascade delete.
create or replace function public.write_audit_log_entry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_circle_id uuid;
  v_type public.log_type;
  v_ref_id uuid;
  v_summary text;
  v_actor uuid;
begin
  v_actor := (select auth.uid());

  if tg_table_name = 'dose_events' then
    if tg_op = 'INSERT' and new.status = 'pending'::public.dose_status then
      return new;
    end if;
    if tg_op = 'UPDATE' and new.status is not distinct from old.status then
      return new;
    end if;
    v_circle_id := new.circle_id;
    v_type := 'dose'::public.log_type;
    v_ref_id := new.id;
    v_summary := format('Dose marked %s', new.status::text);
    v_actor := coalesce(v_actor, new.acted_by);
  elsif tg_table_name = 'medications' then
    v_circle_id := coalesce(new.circle_id, old.circle_id);
    v_type := 'med_change'::public.log_type;
    v_ref_id := coalesce(new.id, old.id);
    v_summary := format('Medication %s: %s', lower(tg_op), coalesce(new.name, old.name));
  elsif tg_table_name = 'appointments' then
    v_circle_id := coalesce(new.circle_id, old.circle_id);
    v_type := 'appointment'::public.log_type;
    v_ref_id := coalesce(new.id, old.id);
    v_summary := format('Appointment %s: %s', lower(tg_op), coalesce(new.title, old.title));
  elsif tg_table_name = 'tasks' then
    v_circle_id := coalesce(new.circle_id, old.circle_id);
    v_type := 'task'::public.log_type;
    v_ref_id := coalesce(new.id, old.id);
    v_summary := format('Task %s: %s', lower(tg_op), coalesce(new.title, old.title));
    if tg_op = 'UPDATE' and new.done_by is not null then
      v_actor := coalesce(v_actor, new.done_by);
    end if;
  elsif tg_table_name = 'visit_notes' then
    v_circle_id := coalesce(new.circle_id, old.circle_id);
    v_type := 'visit_note'::public.log_type;
    v_ref_id := coalesce(new.id, old.id);
    v_summary := 'Visit note recorded';
    v_actor := coalesce(new.created_by, v_actor);
  elsif tg_table_name = 'circle_members' then
    v_circle_id := coalesce(new.circle_id, old.circle_id);
    v_type := 'member'::public.log_type;
    v_ref_id := coalesce(new.user_id, old.user_id);
    if tg_op = 'DELETE' then
      v_summary := format('Member removed (%s)', old.role::text);
      if not exists (select 1 from auth.users where id = old.user_id) then
        v_ref_id := null;
      end if;
    else
      v_summary := format('Member %s as %s', lower(tg_op), new.role::text);
      v_actor := coalesce(v_actor, new.user_id);
    end if;
  else
    return coalesce(new, old);
  end if;

  if not exists (select 1 from public.circles where id = v_circle_id) then
    return coalesce(new, old);
  end if;

  if v_actor is not null and not exists (select 1 from auth.users where id = v_actor) then
    v_actor := null;
  end if;

  insert into public.log_entries (circle_id, type, ref_id, summary, created_by)
  values (v_circle_id, v_type, v_ref_id, v_summary, v_actor);

  return coalesce(new, old);
end;
$$;

revoke all on function public.write_audit_log_entry() from public, anon, authenticated;

-- 4. `public.transfer_ownership("circleId" uuid, "newOwnerId" uuid)`
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

-- 5. `public.export_user_data()`
create or replace function public.export_user_data()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  v_user_id := (select auth.uid());
  if v_user_id is null then
    raise exception 'Authentication required to export user data'
      using errcode = '42501';
  end if;

  return pg_catalog.jsonb_build_object(
    'userId', v_user_id,
    'exportedAt', pg_catalog.now(),
    'profile', (
      select pg_catalog.to_jsonb(up.*)
        from public.users_profile up
       where up.user_id = v_user_id
    ),
    'entitlements', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(e.*))
        from public.entitlements e
       where e.user_id = v_user_id
    ), '[]'::jsonb),
    'memberships', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(cm.*))
        from public.circle_members cm
       where cm.user_id = v_user_id
    ), '[]'::jsonb),
    'circles', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(c.*))
        from public.circles c
       where exists (
         select 1
           from public.circle_members cm
          where cm.circle_id = c.id
            and cm.user_id = v_user_id
       )
    ), '[]'::jsonb),
    'medications', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m.*))
        from public.medications m
       where exists (
         select 1
           from public.circle_members cm
          where cm.circle_id = m.circle_id
            and cm.user_id = v_user_id
       )
    ), '[]'::jsonb),
    'doseEvents', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(de.*))
        from public.dose_events de
       where exists (
         select 1
           from public.circle_members cm
          where cm.circle_id = de.circle_id
            and cm.user_id = v_user_id
       )
    ), '[]'::jsonb),
    'appointments', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a.*))
        from public.appointments a
       where exists (
         select 1
           from public.circle_members cm
          where cm.circle_id = a.circle_id
            and cm.user_id = v_user_id
       )
    ), '[]'::jsonb),
    'tasks', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t.*))
        from public.tasks t
       where exists (
         select 1
           from public.circle_members cm
          where cm.circle_id = t.circle_id
            and cm.user_id = v_user_id
       )
    ), '[]'::jsonb),
    'visitNotes', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(vn.*))
        from public.visit_notes vn
       where exists (
         select 1
           from public.circle_members cm
          where cm.circle_id = vn.circle_id
            and cm.user_id = v_user_id
       )
    ), '[]'::jsonb),
    'logEntries', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(le.*))
        from public.log_entries le
       where exists (
         select 1
           from public.circle_members cm
          where cm.circle_id = le.circle_id
            and cm.user_id = v_user_id
       )
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.export_user_data() from public, anon;
grant execute on function public.export_user_data() to authenticated, service_role;

-- 6. `public.delete_own_account(p_target_user_id uuid default null)`
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
  elsif current_user in ('postgres', 'service_role') and p_target_user_id is not null then
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

  -- Remove any Storage object metadata rows under the user's prefix or solo circle prefixes
  delete from storage.objects
   where bucket_id in ('prescription-photos', 'visit-audio', 'log-exports')
     and (
       (storage.foldername(name))[1] = v_user_id::text
       or (storage.foldername(name))[1] = any(v_solo_circle_texts)
     );

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
