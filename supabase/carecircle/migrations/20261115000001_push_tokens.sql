-- F-6: Push notification tokens per user device (docs/spec/carecircle.md > Part 1 > Notifications).
--
-- One Expo push token belongs to one phone, and a phone has one signed-in user at a time.
-- So `token` is the primary key: when someone else signs in on the same phone and registers,
-- the row moves to them. With a (user_id, token) key the first user's row stayed behind and
-- their family's pushes (e.g. "Dad missed a dose") kept arriving on the new user's phone.
create table public.push_tokens (
  token text primary key
    check (token ~ '^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$'),
  user_id uuid not null references auth.users (id) on delete cascade,
  platform text not null check (platform in ('ios', 'android')),
  updated_at timestamptz not null default now()
);

create index push_tokens_user_id_idx on public.push_tokens (user_id);

alter table public.push_tokens enable row level security;

-- The app registers a token only through public.register_push_token() below, which can take
-- a token over from another user. Direct insert/update stay closed: RLS cannot let user B
-- move user A's row, and a PostgREST upsert would need UPDATE on every column it sends.
revoke all on table public.push_tokens from public, anon, authenticated;
grant select, delete on table public.push_tokens to authenticated;
grant all on table public.push_tokens to service_role;

create policy push_tokens_select_own
  on public.push_tokens
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Delete own: the app removes this phone's token on sign-out.
create policy push_tokens_delete_own
  on public.push_tokens
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create function public.register_push_token(p_token text, p_platform text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  insert into public.push_tokens (token, user_id, platform, updated_at)
  values (p_token, caller, p_platform, now())
  on conflict (token) do update
    set user_id = excluded.user_id,
        platform = excluded.platform,
        updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.register_push_token(text, text) from public, anon;
grant execute on function public.register_push_token(text, text) to authenticated;
