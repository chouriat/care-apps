-- CC-1a: `public.create_circle` RPC (`docs/spec/carecircle.md` > APIs & Roles and permissions).
-- `public.circles` has no direct INSERT grant for `authenticated`; creating a circle and its
-- initial `owner` membership row happens atomically in one transaction via this SECURITY DEFINER RPC.

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

  -- Spec "Roles and permissions": limit is 1 circle (applies to both Free and Family plans).
  -- Until Taha clarifies whether "1 circle" means 1 owned circle or 1 membership in any role,
  -- refuse a second circle that the caller would own.
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
