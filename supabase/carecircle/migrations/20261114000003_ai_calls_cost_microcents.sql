-- AI call costs are usually a fraction of a cent, so whole cents would round to 0.
-- Store them as integer microcents (1 cent = 1,000,000 microcents) plus the currency code.
alter table public.ai_calls rename column estimated_cost_cents to estimated_cost_microcents;
alter table public.ai_calls alter column estimated_cost_microcents type bigint;
alter table public.ai_calls
  add column cost_currency text not null default 'USD' check (cost_currency ~ '^[A-Z]{3}$');
