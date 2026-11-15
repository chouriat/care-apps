-- CC-2a [safety 1/2]: database rules for dose materialization and schedule edits (spec Dose engine rules 1, 2, 4).
-- 1. Materializing doses twice is idempotent (`unique (medication_id, due_at)` with `on conflict do nothing`),
--    leaves `acted_by` and `acted_at` null, does not overwrite given/skipped/missed events, and writes zero
--    `dose` lines to `log_entries`.
-- 2. Editing a medication's `schedule` (or pausing it with `active = false`) automatically deletes ONLY
--    future `pending` `dose_events` (`due_at > now() and status = 'pending'`) of that medication;
--    `given`, `skipped`, `missed` and past `pending` events are untouched; other medications are untouched;
--    and deleting those pending events writes a `med_change` log line for the edit but ZERO `dose` log lines.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(18);

-- 1. Trigger `medications_reconcile_schedule_edit` must exist on `public.medications`
select has_trigger(
  'public',
  'medications',
  'medications_reconcile_schedule_edit',
  'medications has trigger medications_reconcile_schedule_edit for schedule edits and pause'
);

-- Seed owner, circle, and two active medications
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values (
  'cc2a0001-0000-4000-8000-000000000001'::uuid,
  '00000000-0000-0000-0000-000000000000'::uuid,
  'authenticated',
  'authenticated',
  'cc2a-owner@example.test',
  '{}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
);

insert into public.circles (id, name, care_recipient_name, timezone, created_by)
values (
  'cc2ac001-0000-4000-8000-000000000001'::uuid,
  'CC-2a Circle',
  'Evelyn',
  'Europe/Paris',
  'cc2a0001-0000-4000-8000-000000000001'::uuid
);

insert into public.circle_members (circle_id, user_id, role)
values (
  'cc2ac001-0000-4000-8000-000000000001'::uuid,
  'cc2a0001-0000-4000-8000-000000000001'::uuid,
  'owner'
);

insert into public.medications (id, circle_id, name, strength, dose_text, schedule, start_date, active, source)
values
  (
    'cc2a2001-0000-4000-8000-000000000001'::uuid,
    'cc2ac001-0000-4000-8000-000000000001'::uuid,
    'Metformin',
    '500 mg',
    '1 tablet',
    '{"kind":"daily","times":["08:00","20:00"]}'::jsonb,
    current_date - 5,
    true,
    'manual'
  ),
  (
    'cc2a2002-0000-4000-8000-000000000002'::uuid,
    'cc2ac001-0000-4000-8000-000000000001'::uuid,
    'Lisinopril',
    '10 mg',
    '1 tablet',
    '{"kind":"daily","times":["09:00"]}'::jsonb,
    current_date - 5,
    true,
    'manual'
  );

-- 2. Server job materializes pending doses twice: zero duplicates, acted_by is null, zero dose log lines
insert into public.dose_events (medication_id, circle_id, due_at)
values
  ('cc2a2001-0000-4000-8000-000000000001'::uuid, 'cc2ac001-0000-4000-8000-000000000001'::uuid, date_trunc('hour', now()) + interval '6 hours'),
  ('cc2a2001-0000-4000-8000-000000000001'::uuid, 'cc2ac001-0000-4000-8000-000000000001'::uuid, date_trunc('hour', now()) + interval '18 hours')
on conflict (medication_id, due_at) do nothing;

insert into public.dose_events (medication_id, circle_id, due_at)
values
  ('cc2a2001-0000-4000-8000-000000000001'::uuid, 'cc2ac001-0000-4000-8000-000000000001'::uuid, date_trunc('hour', now()) + interval '6 hours'),
  ('cc2a2001-0000-4000-8000-000000000001'::uuid, 'cc2ac001-0000-4000-8000-000000000001'::uuid, date_trunc('hour', now()) + interval '18 hours')
on conflict (medication_id, due_at) do nothing;

select is(
  (select count(*)::int from public.dose_events where medication_id = 'cc2a2001-0000-4000-8000-000000000001'::uuid),
  2,
  'materializing the same 48h window twice creates zero duplicates'
);

select is(
  (select count(*)::int from public.dose_events
    where medication_id = 'cc2a2001-0000-4000-8000-000000000001'::uuid
      and status = 'pending' and acted_by is null and acted_at is null),
  2,
  'server-materialized doses default to pending with acted_by = null and acted_at = null'
);

select is(
  (select count(*)::int from public.log_entries
    where circle_id = 'cc2ac001-0000-4000-8000-000000000001'::uuid and type = 'dose'),
  0,
  'materializing pending dose_events writes zero dose log_entries'
);

-- Seed historical and non-pending dose_events on Metformin plus a future pending dose on Lisinopril
insert into public.dose_events (id, medication_id, circle_id, due_at, status, acted_by, acted_at)
values
  -- Past pending (must survive schedule edit)
  (
    'cc2a3001-0000-4000-8000-000000000001'::uuid,
    'cc2a2001-0000-4000-8000-000000000001'::uuid,
    'cc2ac001-0000-4000-8000-000000000001'::uuid,
    date_trunc('hour', now()) - interval '2 hours',
    'pending',
    null,
    null
  ),
  -- Past given (must survive schedule edit)
  (
    'cc2a3002-0000-4000-8000-000000000002'::uuid,
    'cc2a2001-0000-4000-8000-000000000001'::uuid,
    'cc2ac001-0000-4000-8000-000000000001'::uuid,
    date_trunc('hour', now()) - interval '8 hours',
    'given',
    'cc2a0001-0000-4000-8000-000000000001'::uuid,
    date_trunc('hour', now()) - interval '8 hours'
  ),
  -- Future given (must survive schedule edit)
  (
    'cc2a3003-0000-4000-8000-000000000003'::uuid,
    'cc2a2001-0000-4000-8000-000000000001'::uuid,
    'cc2ac001-0000-4000-8000-000000000001'::uuid,
    date_trunc('hour', now()) + interval '2 hours',
    'given',
    'cc2a0001-0000-4000-8000-000000000001'::uuid,
    now()
  ),
  -- Future skipped (must survive schedule edit)
  (
    'cc2a3004-0000-4000-8000-000000000004'::uuid,
    'cc2a2001-0000-4000-8000-000000000001'::uuid,
    'cc2ac001-0000-4000-8000-000000000001'::uuid,
    date_trunc('hour', now()) + interval '4 hours',
    'skipped',
    'cc2a0001-0000-4000-8000-000000000001'::uuid,
    now()
  ),
  -- Future missed (must survive schedule edit)
  (
    'cc2a3005-0000-4000-8000-000000000005'::uuid,
    'cc2a2001-0000-4000-8000-000000000001'::uuid,
    'cc2ac001-0000-4000-8000-000000000001'::uuid,
    date_trunc('hour', now()) + interval '5 hours',
    'missed',
    null,
    null
  ),
  -- Future pending on Lisinopril (other medicine, must survive Metformin schedule edit)
  (
    'cc2a3006-0000-4000-8000-000000000006'::uuid,
    'cc2a2002-0000-4000-8000-000000000002'::uuid,
    'cc2ac001-0000-4000-8000-000000000001'::uuid,
    date_trunc('hour', now()) + interval '10 hours',
    'pending',
    null,
    null
  );

-- Count dose log entries before editing Metformin's schedule (4 from the non-pending seed inserts above)
select is(
  (select count(*)::int from public.log_entries
    where circle_id = 'cc2ac001-0000-4000-8000-000000000001'::uuid and type = 'dose'),
  4,
  '4 dose log entries exist from non-pending seed events before schedule edit'
);

-- 3. Edit Metformin's schedule as the signed-in circle owner
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'cc2a0001-0000-4000-8000-000000000001', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"cc2a0001-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

update public.medications
   set schedule = '{"kind":"daily","times":["09:00"]}'::jsonb
 where id = 'cc2a2001-0000-4000-8000-000000000001'::uuid;

set local role postgres;

select is(
  (select count(*)::int from public.dose_events
    where medication_id = 'cc2a2001-0000-4000-8000-000000000001'::uuid
      and status = 'pending' and due_at > now()),
  0,
  'editing schedule deletes all future pending dose_events of that medication'
);

select is(
  (select count(*)::int from public.dose_events where id = 'cc2a3001-0000-4000-8000-000000000001'::uuid),
  1,
  'past pending dose_event is untouched by schedule edit'
);

select is(
  (select count(*)::int from public.dose_events where id = 'cc2a3002-0000-4000-8000-000000000002'::uuid),
  1,
  'past given dose_event is untouched by schedule edit'
);

select is(
  (select count(*)::int from public.dose_events where id = 'cc2a3003-0000-4000-8000-000000000003'::uuid),
  1,
  'future given dose_event is untouched by schedule edit'
);

select is(
  (select count(*)::int from public.dose_events where id = 'cc2a3004-0000-4000-8000-000000000004'::uuid),
  1,
  'future skipped dose_event is untouched by schedule edit'
);

select is(
  (select count(*)::int from public.dose_events where id = 'cc2a3005-0000-4000-8000-000000000005'::uuid),
  1,
  'future missed dose_event is untouched by schedule edit'
);

select is(
  (select count(*)::int from public.dose_events where id = 'cc2a3006-0000-4000-8000-000000000006'::uuid),
  1,
  'another medication''s future pending dose_event is untouched by schedule edit'
);

select is(
  (select count(*)::int from public.log_entries
    where circle_id = 'cc2ac001-0000-4000-8000-000000000001'::uuid and type = 'dose'),
  4,
  'deleting future pending doses on schedule edit writes zero dose log_entries'
);

select is(
  (select count(*)::int from public.log_entries
    where circle_id = 'cc2ac001-0000-4000-8000-000000000001'::uuid
      and type = 'med_change'
      and ref_id = 'cc2a2001-0000-4000-8000-000000000001'::uuid),
  2,
  'log_entries records the med_change line for the schedule edit (1 insert + 1 update)'
);

-- 4. Editing a non-schedule field (e.g. instructions) does NOT delete future pending doses
insert into public.dose_events (id, medication_id, circle_id, due_at, status)
values (
  'cc2a3007-0000-4000-8000-000000000007'::uuid,
  'cc2a2001-0000-4000-8000-000000000001'::uuid,
  'cc2ac001-0000-4000-8000-000000000001'::uuid,
  date_trunc('hour', now()) + interval '9 hours',
  'pending'
);

set local role authenticated;
update public.medications
   set instructions = 'Take with a full glass of water'
 where id = 'cc2a2001-0000-4000-8000-000000000001'::uuid;
set local role postgres;

select is(
  (select count(*)::int from public.dose_events where id = 'cc2a3007-0000-4000-8000-000000000007'::uuid),
  1,
  'editing instructions alone does not delete future pending doses'
);

-- 5. Pausing a medication (active = false) deletes its future pending doses without writing dose log lines
set local role authenticated;
update public.medications
   set active = false
 where id = 'cc2a2002-0000-4000-8000-000000000002'::uuid;
set local role postgres;

select is(
  (select count(*)::int from public.dose_events where id = 'cc2a3006-0000-4000-8000-000000000006'::uuid),
  0,
  'pausing a medication (active = false) deletes its future pending dose_events'
);

select is(
  (select count(*)::int from public.log_entries
    where circle_id = 'cc2ac001-0000-4000-8000-000000000001'::uuid and type = 'dose'),
  4,
  'pausing a medication writes zero dose log_entries for deleted pending doses'
);

-- 6. Re-materializing over an already-given slot does not overwrite status or acted_by
insert into public.dose_events (medication_id, circle_id, due_at, status)
values (
  'cc2a2001-0000-4000-8000-000000000001'::uuid,
  'cc2ac001-0000-4000-8000-000000000001'::uuid,
  date_trunc('hour', now()) + interval '2 hours',
  'pending'
)
on conflict (medication_id, due_at) do nothing;

select is(
  (select status::text from public.dose_events where id = 'cc2a3003-0000-4000-8000-000000000003'::uuid),
  'given',
  'on conflict (medication_id, due_at) do nothing preserves existing given dose status'
);

select * from finish();

rollback;
