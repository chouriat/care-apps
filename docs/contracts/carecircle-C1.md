# Contract C1: CareCircle Domain Schema, RLS, and Access Rules

This document specifies **Contract C1** for CareCircle: the Postgres enums, the 9 domain tables, Row Level Security (RLS) and column-privilege access rules, the append-only care audit log (`log_entries`), the Zod schemas in `@carecircle/core`, and the `MOCKS=1` (`EXPO_PUBLIC_MOCKS=1`) mock dataset.

- **Migration:** [`supabase/carecircle/migrations/20261115000005_carecircle_c1.sql`](../../supabase/carecircle/migrations/20261115000005_carecircle_c1.sql)
- **Zod Schemas & Mock Data:** [`packages/core/schemas/carecircle.ts`](../../packages/core/schemas/carecircle.ts)
- **pgTAP Tests:** [`supabase/carecircle/tests/c1_schema_rls.test.sql`](../../supabase/carecircle/tests/c1_schema_rls.test.sql), [`supabase/carecircle/tests/c1_access_rules.test.sql`](../../supabase/carecircle/tests/c1_access_rules.test.sql)
- **Unit Tests:** [`packages/core/src/carecircle.test.ts`](../../packages/core/src/carecircle.test.ts), [`apps/carecircle/src/mocks.test.tsx`](../../apps/carecircle/src/mocks.test.tsx)

---

## 1. Enums

| Enum | Values |
| --- | --- |
| `public.member_role` | `'owner'`, `'helper'`, `'viewer'` |
| `public.dose_status` | `'pending'`, `'given'`, `'skipped'`, `'missed'` |
| `public.log_type` | `'dose'`, `'med_change'`, `'appointment'`, `'task'`, `'visit_note'`, `'member'` |

---

## 2. Tables and Constraints

1. **`public.circles`**
   - Columns: `id uuid PK`, `name text not null`, `care_recipient_name text not null`, `care_recipient_dob date`, `timezone text not null`, `created_by uuid references auth.users(id) on delete set null default auth.uid()`, `created_at timestamptz not null default now()`.
2. **`public.circle_members`**
   - Columns: `circle_id uuid not null references circles(id) on delete cascade`, `user_id uuid not null references auth.users(id) on delete cascade`, `role member_role not null`, `joined_at timestamptz not null default now()`.
   - Primary key: `(circle_id, user_id)`.
   - Single-owner invariant: unique partial index `circle_members_one_owner_idx` on `(circle_id) where role = 'owner'`, plus trigger `circle_members_prevent_ownerless` preventing owner demotion or owner deletion while the circle exists.
3. **`public.invites`**
   - Columns: `id uuid PK`, `circle_id uuid not null references circles(id) on delete cascade`, `token text not null unique default encode(extensions.gen_random_bytes(32), 'hex') check (char_length(token) >= 32)`, `role member_role not null default 'helper' check (role <> 'owner')`, `expires_at timestamptz not null default (now() + interval '7 days')`, `used_by uuid references auth.users(id) on delete set null`.
4. **`public.medications`**
   - Columns: `id uuid PK`, `circle_id uuid not null references circles(id) on delete cascade`, `name text not null`, `strength text`, `dose_text text not null`, `schedule jsonb not null`, `instructions text`, `start_date date default current_date`, `end_date date`, `active boolean not null default true`, `source text not null check (source in ('manual', 'photo'))`.
   - Schedule check: `jsonb_typeof(schedule) = 'object' and (schedule->>'kind') in ('daily', 'weekly', 'every_n_days', 'as_needed')`.
   - Composite unique constraint: `unique (id, circle_id)` so child tables can enforce same-circle foreign keys.
5. **`public.dose_events`**
   - Columns: `id uuid PK`, `medication_id uuid not null references medications(id) on delete cascade`, `circle_id uuid not null references circles(id) on delete cascade`, `due_at timestamptz not null`, `status dose_status not null default 'pending'`, `acted_by uuid references auth.users(id) on delete set null`, `acted_at timestamptz`.
   - Constraints: `unique (medication_id, due_at)` and composite `foreign key (medication_id, circle_id) references medications(id, circle_id) on delete cascade` (prevents linking a dose event in circle B to a medication in circle A).
6. **`public.appointments`**
   - Columns: `id uuid PK`, `circle_id uuid not null references circles(id) on delete cascade`, `title text not null`, `starts_at timestamptz not null`, `ends_at timestamptz`, `location text`, `driver_user_id uuid references auth.users(id) on delete set null`, `notes text`.
   - Composite unique constraint: `unique (id, circle_id)`.
7. **`public.tasks`**
   - Columns: `id uuid PK`, `circle_id uuid not null references circles(id) on delete cascade`, `title text not null`, `due_at timestamptz`, `assignee uuid references auth.users(id) on delete set null`, `done_at timestamptz`, `done_by uuid references auth.users(id) on delete set null`, `source text not null check (source in ('manual', 'visit_note'))`.
8. **`public.visit_notes`**
   - Columns: `id uuid PK`, `circle_id uuid not null references circles(id) on delete cascade`, `appointment_id uuid references appointments(id) on delete set null`, `transcript text`, `summary text`, `created_by uuid references auth.users(id) on delete set null default auth.uid()`, `created_at timestamptz not null default now()`.
   - Composite FK: `foreign key (appointment_id, circle_id) references appointments(id, circle_id) on delete set null (appointment_id)` (prevents cross-circle appointment references while keeping `circle_id` non-null if the appointment is deleted).
9. **`public.log_entries`**
   - Columns: `id uuid PK`, `circle_id uuid not null references circles(id) on delete cascade`, `type log_type not null`, `ref_id uuid`, `summary text`, `created_by uuid references auth.users(id) on delete set null`, `created_at timestamptz not null default now()`.

---

## 3. Access Rules

All 9 tables have Row Level Security enabled (`ENABLE ROW LEVEL SECURITY`) and default privileges revoked from `public`, `anon`, and `authenticated`.

| Table | `anon` / Outsider / Other Circle Member | `viewer` (in circle) | `helper` (in circle) | `owner` (in circle) |
| --- | --- | --- | --- | --- |
| `circles` | None | `SELECT` | `SELECT` | `SELECT`, `UPDATE`, `DELETE` (`INSERT` is via `create_circle` RPC in CC-1a) |
| `circle_members` | None | `SELECT`, `DELETE` own row (leave) | `SELECT`, `DELETE` own row (leave) | `SELECT`, `UPDATE (role)` of other members to `'helper'`/`'viewer'`, `DELETE` other members (`INSERT` is via `accept_invite` RPC in CC-1b) |
| `invites` | None | None (cannot read tokens) | None (cannot read tokens) | `SELECT`, `INSERT (circle_id, role, expires_at)` (DB generates 64-hex token; `role <> 'owner'`), `DELETE` |
| `medications` | None | `SELECT` | `SELECT`, `INSERT`, `UPDATE`, `DELETE` | `SELECT`, `INSERT`, `UPDATE`, `DELETE` |
| `dose_events` | None | `SELECT` | `SELECT`, `INSERT`, `UPDATE`, `DELETE` | `SELECT`, `INSERT`, `UPDATE`, `DELETE` |
| `appointments` | None | `SELECT` | `SELECT`, `INSERT`, `UPDATE`, `DELETE` | `SELECT`, `INSERT`, `UPDATE`, `DELETE` |
| `tasks` | None | `SELECT` | `SELECT`, `INSERT`, `UPDATE`, `DELETE` | `SELECT`, `INSERT`, `UPDATE`, `DELETE` |
| `visit_notes` | None | `SELECT` | `SELECT`, `INSERT`, `UPDATE`, `DELETE` (`created_by` set by DB default `auth.uid()`, never client-writable) | `SELECT`, `INSERT`, `UPDATE`, `DELETE` (`created_by` set by DB default `auth.uid()`) |
| `log_entries` | None | `SELECT` | `SELECT` | `SELECT` (inserts happen only via `SECURITY DEFINER` audit triggers; `UPDATE` and `DELETE` are blocked by `log_entries_immutable` except when the parent circle is cascade-deleted) |

### Added in review (PR #23)

- **No moving rows between families.** `UPDATE` is granted per column and never on `id` or `circle_id` (`medications`, `dose_events`, `appointments`, `tasks`, `visit_notes`). On `circles`, only `name`, `care_recipient_name`, `care_recipient_dob` and `timezone` are updatable. `visit_notes.created_at` is set by the database.
- **People on a row belong to that circle.** The `check_circle_people` trigger refuses an `acted_by`, `done_by`, `assignee` or `driver_user_id` that is not a member of the row's circle (checked only when the statement sets or changes it, so tasks of someone who left stay editable).
- **Actions are recorded as yourself.** A signed-in user can set `acted_by` / `done_by` only to their own id. Server jobs (no signed-in user) may leave them `null`. Log entries name `auth.uid()`, or `acted_by` / `done_by` for server jobs.
- **Account deletion.** Deleting a user whose row is `owner` fails while the circle exists (`prevent_ownerless_circle`), which matches the spec: an owner transfers or deletes the circle first.
