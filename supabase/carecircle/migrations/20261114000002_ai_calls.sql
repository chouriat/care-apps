create table public.ai_calls (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  task text not null,
  model text not null,
  prompt_version text not null,
  latency_ms integer not null check (latency_ms >= 0),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  estimated_cost_cents integer not null default 0 check (estimated_cost_cents >= 0),
  validation_ok boolean not null,
  error_code text,
  created_at timestamptz not null default now()
);
create index ai_calls_user_created_idx on public.ai_calls (user_id, created_at desc);
alter table public.ai_calls enable row level security;
revoke all on table public.ai_calls from public, anon, authenticated;
grant all on table public.ai_calls to service_role;
