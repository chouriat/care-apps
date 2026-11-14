create table public.users_profile (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  locale text,
  timezone text,
  created_at timestamptz not null default now()
);

alter table public.users_profile enable row level security;

revoke all on table public.users_profile from public, anon, authenticated;
grant select on table public.users_profile to authenticated;
-- Users may edit only their own profile fields; user_id and created_at stay as the sign-up trigger set them.
grant update (display_name, locale, timezone) on table public.users_profile to authenticated;
grant all on table public.users_profile to service_role;

create policy users_profile_select_own
  on public.users_profile
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy users_profile_update_own
  on public.users_profile
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users_profile (user_id)
  values (new.id);
  return new;
end;
$$;

-- Only the trigger calls this function; nobody needs to execute it directly.
revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();
