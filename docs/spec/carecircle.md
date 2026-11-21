# CareCircle spec

Copy of the shared-platform and CareCircle sections of "Product & technical specs: CareCircle, SafePlate, SubSense" (as of 2026-11-13). This file is what Gemini builds from.

CareCircle MVP is one shared care plan per parent: meds with dose tracking, appointments, tasks, AI-drafted visit notes and a care log, synced live across the family. Not in MVP: wearables, telehealth, pharmacy links, agency portal, more than one care recipient per circle.

---

## Part 1: Shared platform

### Auth

Supabase Auth with Sign in with Apple, Google, and email magic link. No passwords. A `users_profile(user_id uuid pk, display_name text, locale text, timezone text, created_at timestamptz, health_consent_at timestamptz)` table exists. `health_consent_at` is null until the person gives explicit consent to health data; it is set only by `give_health_consent()` and never changes after. `timezone` is an IANA name and drives all reminder scheduling.

CareCircle has its own Supabase project (each app has its own).

### AI gateway

One Edge Function at `POST /functions/v1/ai`. The app never calls a model directly.

```json
// request
{ "task": "carecircle.extractPrescription", "input": { }, "requestId": "uuid" }
// success
{ "ok": true, "output": { }, "model": "provider/model-id", "latencyMs": 2310 }
// failure
{ "ok": false, "error": { "code": "SCHEMA_INVALID", "message": "...", "retryable": false } }
```

| Error code | When | App behaviour |
| --- | --- | --- |
| `UNAUTHENTICATED` | No or expired JWT | Send to sign-in |
| `QUOTA_EXCEEDED` | Free-tier limit hit | Show paywall |
| `INPUT_INVALID` | Photo missing, unreadable, not yours to read, not a JPEG, or over 2 MB | Ask user to retake |
| `SCHEMA_INVALID` | Model output failed validation twice | Show "couldn't read that, add it manually" |
| `PROVIDER_ERROR` | Model API down or timed out (25 s cap) | Retry button; `retryable: true` |

- Routing lives in `supabase/functions/ai/routes.ts`: one entry per task naming provider, model, prompt file, schema and timeout.
- Prompts live in `packages/ai-gateway/prompts/<app>/<task>.md`, versioned. The gateway logs `task`, `model`, `prompt_version`, `latencyMs`, token counts and validation result to an `ai_calls` table. Raw images and audio are NOT logged.
- Images are resized on device to max 1600 px on the long edge, JPEG quality 0.8, before upload.

### Entitlements

RevenueCat entitlement ID: `carecircle_family`. A RevenueCat webhook writes `entitlements(user_id, entitlement, active, expires_at)`. Server-side limits read this table, never the client.

### Notifications

Local notifications for anything the device can compute (dose reminders on the device of the assigned helper). Push via Expo for anything triggered by someone else (a missed dose, a new task). Push tokens live in `push_tokens(user_id, token, platform, updated_at)`.

### Analytics

PostHog event names are `snake_case`, past tense, prefixed `cc_`. Never send health details, medication names or free text as properties; send counts and enums only.

### Design system

`packages/ui` exposes tokens (colour, spacing on a 4 px grid, type scale) and these components: `Screen`, `Header`, `Button`, `Card`, `ListRow`, `Chip`, `Sheet`, `EmptyState`, `ErrorState`, `ConfirmDraft` (the editable-AI-draft pattern). Minimum touch target 44 pt; dynamic type; WCAG AA contrast.

### Account deletion

Settings > Delete account calls `POST /functions/v1/delete-account`, which removes all the user's rows and Storage files within 24 hours. It cancels nothing in the stores; the screen links to store subscription settings. In CareCircle, an owner must transfer or delete the circle first.

---

## Part 2: CareCircle

### Roles and permissions

| Action | owner | helper | viewer |
| --- | --- | --- | --- |
| Read everything in the circle | yes | yes | yes |
| Mark dose given or skipped, complete tasks | yes | yes | no |
| Add or edit meds, appointments, tasks, notes | yes | yes | no |
| Invite members, change roles, remove members | yes | no | no |
| Delete the circle | yes | no | no |

A circle has exactly one owner. The owner MAY transfer ownership; the last owner cannot leave without transferring or deleting. Free plan: 1 circle, up to 2 members. `carecircle_family`: 1 circle, up to 8 members, visit-note AI, PDF export.

### Data model (contract C1)

```sql
create type member_role as enum ('owner','helper','viewer');
create type dose_status as enum ('pending','given','skipped','missed');
create type log_type as enum ('dose','med_change','appointment','task','visit_note','member');

circles(id uuid pk, name text not null, care_recipient_name text not null,
        care_recipient_dob date null, timezone text not null, created_by uuid, created_at timestamptz)
circle_members(circle_id uuid fk, user_id uuid fk, role member_role, joined_at timestamptz,
               primary key (circle_id, user_id))
invites(id uuid pk, circle_id uuid fk, token text unique, role member_role default 'helper',
        expires_at timestamptz, used_by uuid null)
medications(id uuid pk, circle_id uuid fk, name text not null, strength text null, -- "10 mg"
            dose_text text not null, -- "1 tablet"
            schedule jsonb not null, instructions text null, start_date date, end_date date null,
            active bool default true, source text check (source in ('manual','photo')))
dose_events(id uuid pk, medication_id uuid fk, circle_id uuid fk, due_at timestamptz,
            status dose_status default 'pending', acted_by uuid null, acted_at timestamptz null,
            unique (medication_id, due_at))
appointments(id uuid pk, circle_id uuid fk, title text, starts_at timestamptz, ends_at timestamptz null,
             location text null, driver_user_id uuid null, notes text null)
tasks(id uuid pk, circle_id uuid fk, title text, due_at timestamptz null, assignee uuid null,
      done_at timestamptz null, done_by uuid null, source text check (source in ('manual','visit_note')))
visit_notes(id uuid pk, circle_id uuid fk, appointment_id uuid null, transcript text,
            summary text, created_by uuid, created_at timestamptz)
log_entries(id uuid pk, circle_id uuid fk, type log_type, ref_id uuid, summary text,
            created_by uuid, created_at timestamptz)
```

`schedule` is JSON, not an RRULE string:

```json
{ "kind": "daily", "times": ["08:00", "20:00"] }
{ "kind": "weekly", "days": ["mon", "thu"], "times": ["09:00"] }
{ "kind": "every_n_days", "n": 3, "times": ["08:00"] }
{ "kind": "as_needed" }
```

Times are local to `circles.timezone`. RLS: every table with `circle_id` allows select when the user is in `circle_members` for that circle, and insert/update/delete per the roles table. `log_entries` is insert-only from triggers; nobody updates or deletes it.

### Dose engine

1. A scheduled Edge Function `materialize-doses` runs every hour and creates `dose_events` for the next 48 hours from each active medication. The unique key makes it idempotent.
2. `as_needed` meds create no events; the user logs "Gave a dose now", which inserts a `given` event at the current time.
3. A dose still `pending` 60 minutes after `due_at` becomes `missed` (job `mark-missed`, every 5 minutes) and sends a push to the owner and every helper (never viewers).
4. Editing a schedule deletes only future `pending` events and re-materializes. History is never rewritten.
5. Daylight saving: a time that does not exist (02:30 on spring-forward) moves to the next valid minute; a repeated time fires once.

### AI contracts (contract C2)

`carecircle.extractPrescription` input `{ imagePath: string }` (Storage path), output:

```json
{
  "name": "Metformin",
  "strength": "500 mg",
  "doseText": "1 tablet",
  "schedule": { "kind": "daily", "times": ["08:00", "20:00"] },
  "instructions": "Take with food",
  "fieldConfidence": { "name": 0.97, "strength": 0.92, "schedule": 0.71 },
  "rawText": "string"
}
```

A field with confidence under 0.8 is highlighted on the confirm screen. "twice daily" maps to 08:00 and 20:00; "three times daily" to 08:00, 14:00, 20:00; the user can edit.

`carecircle.summarizeVisit` input `{ circleId?: string, audioPath?: string, text?: string, knownMeds: [{id, name, strength}] }` (one of audio or text required; `circleId` is required with `text`; with `audioPath` it must match the circle in the path; audio max 10 minutes), output:

```json
{
  "summary": "3 to 6 plain-language sentences",
  "followUps": [{ "title": "Book blood test", "dueHint": "in 2 weeks", "dueDate": "2026-11-23" }],
  "medChanges": [{ "action": "stop", "medicationId": "uuid", "name": "Aspirin", "detail": "Stop until next visit" }],
  "questionsToAsk": ["string"]
}
```

`medChanges[].action` is one of `start`, `stop`, `change_dose`. A `start` has `medicationId: null`. Nothing is applied until the user confirms each item. Transcription uses the gateway's speech-to-text route first; the summary model sees only the transcript.

### Screens

| Screen | Route | Shows | Primary actions |
| --- | --- | --- | --- |
| Welcome / sign in | `/(auth)/sign-in` | Value prop, sign-in buttons | Sign in |
| Create or join | `/(onboarding)/start` | Two choices | Create circle; paste or open invite link |
| Today | `/(tabs)/today` | Doses due today grouped by time, next appointment, open tasks due today | Given / Skip on a dose; open item |
| Meds | `/(tabs)/meds` | Active meds, schedule summary, adherence last 7 days | Add (manual or photo), edit, pause |
| Add med by photo | `/meds/scan` | Camera, then `ConfirmDraft` of extracted fields | Retake, edit, save |
| Calendar | `/(tabs)/calendar` | Month and agenda of appointments | Add, assign driver |
| Tasks | `/(tabs)/tasks` | Open and done tasks, filter by assignee | Add, assign, complete |
| Visit note | `/visit/new` | Record (max 10 min) or type, then draft summary, follow-ups and med changes | Accept each item, save |
| Care log | `/log` | Timeline, filter by type and person | Export PDF (Family plan) |
| Circle settings | `/circle` | Members and roles, invite link, plan, delete account | Invite, change role, remove, upgrade |

Every list screen has an `EmptyState` and an `ErrorState`. Today works offline from cache and queues check-offs.

### APIs

CRUD goes straight to Postgres through the Supabase client under RLS. Only these are server functions:

| Endpoint | Input | Output | Notes |
| --- | --- | --- | --- |
| `rpc create_circle` | `name, careRecipientName, timezone` | `circle` | Inserts owner membership in the same transaction |
| `rpc create_invite` | `circleId, role` | `{ url, expiresAt }` | Owner only; link valid 7 days, single use |
| `rpc accept_invite` | `token` | `{ circleId }` | Fails with `INVITE_EXPIRED`, `INVITE_USED`, `CIRCLE_FULL` |
| `rpc set_dose_status` | `doseEventId, status` | `dose_event` | Only `given` or `skipped`; writes a log entry |
| `POST /functions/v1/ai` | see contract C2 | | Family plan only for `summarizeVisit` |
| `POST /functions/v1/export-log` | `circleId, from, to` | `{ pdfUrl }` | Signed URL valid 1 hour; max 90 days per export |
| `POST /functions/v1/delete-account` | none | `{ ok }` | See Account deletion |

Realtime: the app subscribes to `dose_events`, `tasks` and `appointments` filtered by `circle_id`.

### Acceptance criteria

- [ ] Realtime: with two clients in one circle, a check-off on client A shows on client B within 2 seconds on Wi-Fi in 9 of 10 runs
- [ ] **[safety]** Dose engine unit tests (fake clock) cover: daily, weekly, every_n_days, as_needed (creates no events), DST spring-forward (02:30 fires at 03:00), DST fall-back (01:30 fires once), schedule edit (deletes only future `pending` events); running `materialize-doses` twice creates zero duplicates
- [ ] **[safety]** A dose still `pending` 60 minutes after `due_at` is `missed` after the next `mark-missed` run, and one push each is queued for the owner and every helper
- [ ] Prescription photo: on the 20 labels in `evals/carecircle/labels/`, at least 90% of fields (name, strength, doseText, schedule) are correct after the confirm screen; an e2e test proves no `medications` row exists before Save is tapped
- [ ] Visit note: the 5-minute audio fixture returns a schema-valid draft in under 15 seconds at p90 over 10 runs on staging
- [ ] **[safety]** pgTAP RLS tests for every table: a non-member reads 0 rows; a viewer's insert, update and delete fail; a helper cannot create invites or change roles; nobody can update or delete `log_entries`
- [ ] PDF export of the fixture circle (30 days of data) contains the care recipient name, the date range, and one line per log entry (text extraction test)
- [ ] The string `common.notMedicalAdvice` renders on `/meds/scan` and `/visit/new` (component test)
- [ ] **[safety]** After `delete-account`, a service-role query finds 0 rows with that `user_id` and 0 Storage objects under the user's prefix

### Analytics events

`cc_circle_created`, `cc_invite_sent`, `cc_invite_accepted`, `cc_med_added` (prop `source`), `cc_dose_given`, `cc_dose_missed`, `cc_visit_note_saved`, `cc_log_exported`, `cc_paywall_viewed`, `cc_trial_started`.
