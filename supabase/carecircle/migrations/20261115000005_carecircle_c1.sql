-- CareCircle Contract C1: enums, 9 domain tables, RLS policies, grants, and append-only audit log triggers.

create type public.member_role as enum ('owner', 'helper', 'viewer');
create type public.dose_status as enum ('pending', 'given', 'skipped', 'missed');
create type public.log_type as enum (
  'dose',
  'med_change',
  'appointment',
  'task',
  'visit_note',
  'member'
);

-- 1. circles
create table public.circles (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) > 0),
  care_recipient_name text not null check (char_length(btrim(care_recipient_name)) > 0),
  care_recipient_dob date,
  timezone text not null check (char_length(btrim(timezone)) > 0),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

-- 2. circle_members
create table public.circle_members (
  circle_id uuid not null references public.circles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.member_role not null,
  joined_at timestamptz not null default now(),
  primary key (circle_id, user_id)
);

-- Every circle has at most one owner row at any time.
create unique index circle_members_one_owner_idx
  on public.circle_members (circle_id)
  where role = 'owner';

-- 3. invites
create table public.invites (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references public.circles(id) on delete cascade,
  token text not null unique default encode(extensions.gen_random_bytes(32), 'hex') check (char_length(token) >= 32),
  role public.member_role not null default 'helper' check (role <> 'owner'),
  expires_at timestamptz not null default (now() + interval '7 days'),
  used_by uuid references auth.users(id) on delete set null
);

-- 4. medications
create table public.medications (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references public.circles(id) on delete cascade,
  name text not null check (char_length(btrim(name)) > 0),
  strength text,
  dose_text text not null check (char_length(btrim(dose_text)) > 0),
  schedule jsonb not null check (
    jsonb_typeof(schedule) = 'object'
    and (schedule->>'kind') in ('daily', 'weekly', 'every_n_days', 'as_needed')
  ),
  instructions text,
  start_date date default current_date,
  end_date date,
  active boolean not null default true,
  source text not null check (source in ('manual', 'photo')),
  unique (id, circle_id)
);

-- 5. dose_events
create table public.dose_events (
  id uuid primary key default gen_random_uuid(),
  medication_id uuid not null references public.medications(id) on delete cascade,
  circle_id uuid not null references public.circles(id) on delete cascade,
  due_at timestamptz not null,
  status public.dose_status not null default 'pending',
  acted_by uuid references auth.users(id) on delete set null,
  acted_at timestamptz,
  unique (medication_id, due_at),
  foreign key (medication_id, circle_id) references public.medications (id, circle_id) on delete cascade
);

-- 6. appointments
create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references public.circles(id) on delete cascade,
  title text not null check (char_length(btrim(title)) > 0),
  starts_at timestamptz not null,
  ends_at timestamptz,
  location text,
  driver_user_id uuid references auth.users(id) on delete set null,
  notes text,
  unique (id, circle_id)
);

-- 7. tasks
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references public.circles(id) on delete cascade,
  title text not null check (char_length(btrim(title)) > 0),
  due_at timestamptz,
  assignee uuid references auth.users(id) on delete set null,
  done_at timestamptz,
  done_by uuid references auth.users(id) on delete set null,
  source text not null check (source in ('manual', 'visit_note'))
);

-- 8. visit_notes
create table public.visit_notes (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references public.circles(id) on delete cascade,
  appointment_id uuid references public.appointments(id) on delete set null,
  transcript text,
  summary text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (appointment_id, circle_id) references public.appointments (id, circle_id) on delete set null (appointment_id)
);

-- 9. log_entries (append-only audit log)
create table public.log_entries (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references public.circles(id) on delete cascade,
  type public.log_type not null,
  ref_id uuid,
  summary text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Indexes for circle lookups and chronological ordering
create index circle_members_user_id_idx on public.circle_members (user_id);
create index medications_circle_id_idx on public.medications (circle_id);
create index dose_events_circle_due_idx on public.dose_events (circle_id, due_at);
create index appointments_circle_starts_idx on public.appointments (circle_id, starts_at);
create index tasks_circle_due_idx on public.tasks (circle_id, due_at);
create index visit_notes_circle_created_idx on public.visit_notes (circle_id, created_at desc);
create index log_entries_circle_created_idx on public.log_entries (circle_id, created_at desc);

-- Security definer membership helpers (bypass RLS recursion on circle_members)
create or replace function public.is_circle_member(p_circle_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.circle_members
    where circle_id = p_circle_id
      and user_id = (select auth.uid())
  );
$$;

create or replace function public.has_circle_role(
  p_circle_id uuid,
  p_roles public.member_role[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.circle_members
    where circle_id = p_circle_id
      and user_id = (select auth.uid())
      and role = any(p_roles)
  );
$$;

revoke all on function public.is_circle_member(uuid) from public, anon;
grant execute on function public.is_circle_member(uuid) to authenticated, service_role;

revoke all on function public.has_circle_role(uuid, public.member_role[]) from public, anon;
grant execute on function public.has_circle_role(uuid, public.member_role[]) to authenticated, service_role;

-- Prevent demoting or removing the circle owner while the circle exists
create or replace function public.prevent_ownerless_circle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role = 'owner'::public.member_role then
    if tg_op = 'UPDATE' and new.role <> 'owner'::public.member_role then
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

create trigger circle_members_prevent_ownerless
  before update or delete on public.circle_members
  for each row
  execute function public.prevent_ownerless_circle();

-- People named on a row (who gave a dose, who drives, who a task is for, who did it) must be
-- members of that row's circle, so a family's data never points at someone outside the family.
-- When a signed-in user records who gave a dose or did a task, it can only be themselves:
-- the care log and the doctor's PDF rely on these names.
create or replace function public.check_circle_people()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_people uuid[];
  v_self_only uuid[];
  v_person uuid;
begin
  -- Only names that this statement sets or changes are checked, so a task assigned to someone
  -- who has since left the circle can still be edited or completed.
  if tg_table_name = 'dose_events' then
    v_people := array[new.acted_by];
    if tg_op = 'UPDATE' and new.acted_by is not distinct from old.acted_by then
      v_people := array[]::uuid[];
    end if;
    v_self_only := v_people;
  elsif tg_table_name = 'tasks' then
    v_people := array[]::uuid[];
    v_self_only := array[]::uuid[];
    if tg_op = 'INSERT' or new.assignee is distinct from old.assignee then
      v_people := v_people || new.assignee;
    end if;
    if tg_op = 'INSERT' or new.done_by is distinct from old.done_by then
      v_people := v_people || new.done_by;
      v_self_only := array[new.done_by];
    end if;
  elsif tg_table_name = 'appointments' then
    v_people := array[]::uuid[];
    if tg_op = 'INSERT' or new.driver_user_id is distinct from old.driver_user_id then
      v_people := array[new.driver_user_id];
    end if;
    v_self_only := array[]::uuid[];
  else
    return new;
  end if;

  foreach v_person in array v_people loop
    if v_person is not null and not exists (
      select 1 from public.circle_members
      where circle_id = new.circle_id and user_id = v_person
    ) then
      raise exception 'Only members of this circle can be named on its rows' using errcode = '23503';
    end if;
  end loop;

  if (select auth.uid()) is not null then
    foreach v_person in array v_self_only loop
      if v_person is not null and v_person <> (select auth.uid()) then
        raise exception 'You can only record an action as yourself' using errcode = '42501';
      end if;
    end loop;
  end if;

  return new;
end;
$$;

revoke all on function public.check_circle_people() from public, anon, authenticated;

create trigger dose_events_check_people
  before insert or update on public.dose_events
  for each row
  execute function public.check_circle_people();

create trigger tasks_check_people
  before insert or update on public.tasks
  for each row
  execute function public.check_circle_people();

create trigger appointments_check_people
  before insert or update on public.appointments
  for each row
  execute function public.check_circle_people();

-- Enable Row Level Security on all 9 tables
alter table public.circles enable row level security;
alter table public.circle_members enable row level security;
alter table public.invites enable row level security;
alter table public.medications enable row level security;
alter table public.dose_events enable row level security;
alter table public.appointments enable row level security;
alter table public.tasks enable row level security;
alter table public.visit_notes enable row level security;
alter table public.log_entries enable row level security;

-- Table & column privileges: revoke defaults, grant least privilege per table
revoke all on
  public.circles,
  public.circle_members,
  public.invites,
  public.medications,
  public.dose_events,
  public.appointments,
  public.tasks,
  public.visit_notes,
  public.log_entries
from public, anon, authenticated;

grant all on
  public.circles,
  public.circle_members,
  public.invites,
  public.medications,
  public.dose_events,
  public.appointments,
  public.tasks,
  public.visit_notes,
  public.log_entries
to service_role;

-- circles: members read; owner updates/deletes; creation goes through create_circle RPC in CC-1a.
-- Only the editable fields: id, created_by and created_at are never rewritten from the app.
grant select, delete on public.circles to authenticated;
grant update (name, care_recipient_name, care_recipient_dob, timezone) on public.circles to authenticated;

-- circle_members: members read; owner updates role or removes others; non-owner can leave; joining goes through accept_invite RPC in CC-1b
grant select, delete on public.circle_members to authenticated;
grant update (role) on public.circle_members to authenticated;

-- invites: owner creates (server generates token), reads, and cancels; no direct updates
grant select, delete on public.invites to authenticated;
grant insert (circle_id, role, expires_at) on public.invites to authenticated;

-- care coordination tables: members read; owner/helper insert, update, delete.
-- Updates never touch id or circle_id: someone who is a helper in family A and in family B
-- must not be able to move A's medicine, dose, appointment or task into family B.
grant select, insert, delete on
  public.medications,
  public.dose_events,
  public.appointments,
  public.tasks
to authenticated;
grant update (name, strength, dose_text, schedule, instructions, start_date, end_date, active, source)
  on public.medications to authenticated;
grant update (medication_id, due_at, status, acted_by, acted_at) on public.dose_events to authenticated;
grant update (title, starts_at, ends_at, location, driver_user_id, notes) on public.appointments to authenticated;
grant update (title, due_at, assignee, done_at, done_by, source) on public.tasks to authenticated;

-- visit_notes: created_by is always set by the database default (auth.uid()) and cannot be spoofed or rewritten
grant select, delete on public.visit_notes to authenticated;
grant insert (id, circle_id, appointment_id, transcript, summary) on public.visit_notes to authenticated;
grant update (appointment_id, transcript, summary) on public.visit_notes to authenticated;

-- log_entries: members read; only security-definer triggers insert; nobody updates or deletes
grant select on public.log_entries to authenticated;

-- RLS Policies: circles
create policy circles_select_member
  on public.circles
  for select
  to authenticated
  using (public.is_circle_member(id));

create policy circles_update_owner
  on public.circles
  for update
  to authenticated
  using (public.has_circle_role(id, array['owner'::public.member_role]))
  with check (public.has_circle_role(id, array['owner'::public.member_role]));

create policy circles_delete_owner
  on public.circles
  for delete
  to authenticated
  using (public.has_circle_role(id, array['owner'::public.member_role]));

-- RLS Policies: circle_members
create policy circle_members_select_member
  on public.circle_members
  for select
  to authenticated
  using (public.is_circle_member(circle_id));

create policy circle_members_update_owner
  on public.circle_members
  for update
  to authenticated
  using (
    public.has_circle_role(circle_id, array['owner'::public.member_role])
    and user_id <> (select auth.uid())
  )
  with check (
    public.has_circle_role(circle_id, array['owner'::public.member_role])
    and user_id <> (select auth.uid())
    and role in ('helper'::public.member_role, 'viewer'::public.member_role)
  );

create policy circle_members_delete_owner_or_self
  on public.circle_members
  for delete
  to authenticated
  using (
    (
      public.has_circle_role(circle_id, array['owner'::public.member_role])
      and user_id <> (select auth.uid())
    )
    or (
      user_id = (select auth.uid())
      and role <> 'owner'::public.member_role
    )
  );

-- RLS Policies: invites (owner only)
create policy invites_select_owner
  on public.invites
  for select
  to authenticated
  using (public.has_circle_role(circle_id, array['owner'::public.member_role]));

create policy invites_insert_owner
  on public.invites
  for insert
  to authenticated
  with check (public.has_circle_role(circle_id, array['owner'::public.member_role]));

create policy invites_delete_owner
  on public.invites
  for delete
  to authenticated
  using (public.has_circle_role(circle_id, array['owner'::public.member_role]));

-- RLS Policies: medications
create policy medications_select_member
  on public.medications
  for select
  to authenticated
  using (public.is_circle_member(circle_id));

create policy medications_insert_caregiver
  on public.medications
  for insert
  to authenticated
  with check (
    public.has_circle_role(circle_id, array['owner'::public.member_role, 'helper'::public.member_role])
  );

create policy medications_update_caregiver
  on public.medications
  for update
  to authenticated
  using (
    public.has_circle_role(circle_id, array['owner'::public.member_role, 'helper'::public.member_role])
  )
  with check (
    public.has_circle_role(circle_id, array['owner'::public.member_role, 'helper'::public.member_role])
  );

create policy medications_delete_caregiver
  on public.medications
  for delete
  to authenticated
  using (
    public.has_circle_role(circle_id, array['owner'::public.member_role, 'helper'::public.member_role])
  );

-- RLS Policies: dose_events
create policy dose_events_select_member
  on public.dose_events
  for select
  to authenticated
  using (public.is_circle_member(circle_id));

create policy dose_events_insert_caregiver
  on public.dose_events
  for insert
  to authenticated
  with check (
    public.has_circle_role(circle_id, array['owner'::public.member_role, 'helper'::public.member_role])
  );

create policy dose_events_update_caregiver
  on public.dose_events
  for update
  to authenticated
  using (
    public.has_circle_role(circle_id, array['owner'::public.member_role, 'helper'::public.member_role])
  )
  with check (
    public.has_circle_role(circle_id, array['owner'::public.member_role, 'helper'::public.member_role])
  );

create policy dose_events_delete_caregiver
  on public.dose_events
  for delete
  to authenticated
  using (
    public.has_circle_role(circle_id, array['owner'::public.member_role, 'helper'::public.member_role])
  );

-- RLS Policies: appointments
create policy appointments_select_member
  on public.appointments
  for select
  to authenticated
  using (public.is_circle_member(circle_id));

create policy appointments_insert_caregiver
  on public.appointments
  for insert
  to authenticated
  with check (
    public.has_circle_role(circle_id, array['owner'::public.member_role, 'helper'::public.member_role])
  );

create policy appointments_update_caregiver
  on public.appointments
  for update
  to authenticated
  using (
    public.has_circle_role(circle_id, array['owner'::public.member_role, 'helper'::public.member_role])
  )
  with check (
    public.has_circle_role(circle_id, array['owner'::public.member_role, 'helper'::public.member_role])
  );

create policy appointments_delete_caregiver
  on public.appointments
  for delete
  to authenticated
  using (
    public.has_circle_role(circle_id, array['owner'::public.member_role, 'helper'::public.member_role])
  );

-- RLS Policies: tasks
create policy tasks_insert_caregiver
  on public.tasks
  for insert
  to authenticated
  with check (
    public.has_circle_role(circle_id, array['owner'::public.member_role, 'helper'::public.member_role])
  );

create policy tasks_read_member
  on public.tasks
  for select
  to authenticated
  using (public.is_circle_member(circle_id));

create policy tasks_update_caregiver
  on public.tasks
  for update
  to authenticated
  using (
    public.has_circle_role(circle_id, array['owner'::public.member_role, 'helper'::public.member_role])
  )
  with check (
    public.has_circle_role(circle_id, array['owner'::public.member_role, 'helper'::public.member_role])
  );

create policy tasks_delete_caregiver
  on public.tasks
  for delete
  to authenticated
  using (
    public.has_circle_role(circle_id, array['owner'::public.member_role, 'helper'::public.member_role])
  );

-- RLS Policies: visit_notes
create policy visit_notes_select_member
  on public.visit_notes
  for select
  to authenticated
  using (public.is_circle_member(circle_id));

create policy visit_notes_insert_caregiver
  on public.visit_notes
  for insert
  to authenticated
  with check (
    public.has_circle_role(circle_id, array['owner'::public.member_role, 'helper'::public.member_role])
  );

create policy visit_notes_update_caregiver
  on public.visit_notes
  for update
  to authenticated
  using (
    public.has_circle_role(circle_id, array['owner'::public.member_role, 'helper'::public.member_role])
  )
  with check (
    public.has_circle_role(circle_id, array['owner'::public.member_role, 'helper'::public.member_role])
  );

create policy visit_notes_delete_caregiver
  on public.visit_notes
  for delete
  to authenticated
  using (
    public.has_circle_role(circle_id, array['owner'::public.member_role, 'helper'::public.member_role])
  );

-- RLS Policies: log_entries (read-only for circle members)
create policy log_entries_select_member
  on public.log_entries
  for select
  to authenticated
  using (public.is_circle_member(circle_id));

-- Immutability guard on log_entries: blocks UPDATE and DELETE for all roles (except cascade delete when circle is deleted)
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
  -- Deleting a user account (CC-10) clears created_by through `on delete set null`. That is the only
  -- change allowed: the line itself stays in the family's care log.
  if tg_op = 'UPDATE'
    and old.created_by is not null
    and new.created_by is null
    and (new.id, new.circle_id, new.type, new.ref_id, new.summary, new.created_at)
      is not distinct from (old.id, old.circle_id, old.type, old.ref_id, old.summary, old.created_at)
    and not exists (select 1 from auth.users where id = old.created_by) then
    return new;
  end if;
  raise exception 'log_entries is append-only and cannot be updated or deleted'
    using errcode = '42501';
end;
$$;

revoke all on function public.prevent_log_entries_mutation() from public, anon, authenticated;

create trigger log_entries_immutable
  before update or delete on public.log_entries
  for each row
  execute function public.prevent_log_entries_mutation();

-- Audit log trigger function: appends rows to log_entries for all 6 log_type categories
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

  insert into public.log_entries (circle_id, type, ref_id, summary, created_by)
  values (v_circle_id, v_type, v_ref_id, v_summary, v_actor);

  return coalesce(new, old);
end;
$$;

revoke all on function public.write_audit_log_entry() from public, anon, authenticated;

create trigger audit_dose_events
  after insert or update on public.dose_events
  for each row
  execute function public.write_audit_log_entry();

create trigger audit_medications
  after insert or update or delete on public.medications
  for each row
  execute function public.write_audit_log_entry();

create trigger audit_appointments
  after insert on public.appointments
  for each row
  execute function public.write_audit_log_entry();

create trigger audit_tasks
  after insert or update on public.tasks
  for each row
  execute function public.write_audit_log_entry();

create trigger audit_visit_notes
  after insert on public.visit_notes
  for each row
  execute function public.write_audit_log_entry();

create trigger audit_circle_members
  after insert or update or delete on public.circle_members
  for each row
  execute function public.write_audit_log_entry();
