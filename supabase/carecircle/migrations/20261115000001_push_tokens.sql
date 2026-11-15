-- F-6: Push notification tokens per user device (docs/spec/carecircle.md > Part 1 > Notifications).
create table public.push_tokens (
  user_id uuid not null references auth.users (id) on delete cascade,
  token text not null check (char_length(btrim(token)) > 0),
  platform text not null check (platform in ('ios', 'android')),
  updated_at timestamptz not null default now(),
  primary key (user_id, token)
);

create index push_tokens_user_id_idx on public.push_tokens (user_id);

alter table public.push_tokens enable row level security;

revoke all on table public.push_tokens from public, anon, authenticated;
grant select, insert, update (platform, updated_at), delete on table public.push_tokens to authenticated;
grant all on table public.push_tokens to service_role;

create policy push_tokens_select_own
  on public.push_tokens
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy push_tokens_insert_own
  on public.push_tokens
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy push_tokens_update_own
  on public.push_tokens
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy push_tokens_delete_own
  on public.push_tokens
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);
