-- F-5 Paywall on RevenueCat: entitlements table and RLS.
-- Spec: docs/spec/carecircle.md > Part 1 > Entitlements.
-- Written exclusively by the RevenueCat webhook (service_role); authenticated users may only SELECT their own row.

create table public.entitlements (
  user_id uuid not null references auth.users(id) on delete cascade,
  entitlement text not null check (char_length(btrim(entitlement)) > 0),
  active boolean not null default false,
  expires_at timestamptz null,
  primary key (user_id, entitlement)
);

alter table public.entitlements enable row level security;

revoke all on public.entitlements from public, anon, authenticated;
grant select on public.entitlements to authenticated;
grant all on public.entitlements to service_role;

create policy entitlements_select_own
  on public.entitlements
  for select
  to authenticated
  using ((select auth.uid()) = user_id);
