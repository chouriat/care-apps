# CareCircle task cards

Give Gemini one card at a time, in this order. Each card is self-contained: paste it as a GitHub issue or straight into the Gemini session. G1 = Gemini session for data, backend and AI logic. G2 = Gemini session for screens and UI. Cards in the same step with different sessions can run in parallel.

Task IDs match the build plan. Acceptance criteria come from `docs/spec/carecircle.md`; if a card and the spec disagree, the spec wins.

Order at a glance:

| Step | G1 (backend) | G2 (screens) |
| --- | --- | --- |
| 1 | F-0 Monorepo and CI | (waits for F-0) |
| 2 | F-1 Supabase and RLS harness | F-3a Design tokens |
| 3 | F-2a ai-gateway core | F-3b Components |
| 4 | F-2b ai-gateway providers | F-4 Auth |
| 5 | F-6 Notifications, F-7 Analytics | F-5 Paywall, F-8 Maestro and EAS |
| 6 | CC-0 Contracts C1 and C2 | (waits for CC-0 mocks) |
| 7 | CC-2a Dose generator | CC-1a Onboarding and create circle |
| 8 | CC-2b Missed doses and realtime | CC-1b Invites and roles, CC-3a Today |
| 9 | CC-5a Visit note AI | CC-3b Meds screens, CC-4a Photo extract |
| 10 | CC-5b Visit note review | CC-4b Confirm screen and test set |
| 11 | CC-7 Care log and PDF, CC-8 Paywall, CC-10 Delete account | CC-6a Appointments, CC-6b Tasks |

After step 11, Claude takes over with CC-F1 to CC-F4 (improve, test hardening, deploy, hosting).

---

## Foundation

### F-0 Monorepo, Expo shell and CI
Session: G1 · Depends on: empty repo · Review: standard
Branch: `task/f-0-monorepo`
Do:
- pnpm workspaces + Turborepo with `apps/carecircle`, `packages/ui`, `packages/core`, `packages/ai-gateway`, `supabase/carecircle` as in AGENTS.md section 4.
- Expo app in `apps/carecircle` with Expo Router, TypeScript strict, New Architecture on, one placeholder route.
- ESLint + Prettier shared config. Scripts at root: `pnpm typecheck`, `pnpm lint`, `pnpm test`.
- GitHub Actions: on every PR run typecheck, lint and test.
- Commit `AGENTS.md`, `GEMINI.md`, `CLAUDE.md`, `docs/spec/carecircle.md`, `docs/tasks/carecircle.md` exactly as provided.
- `.github/pull_request_template.md` = the template in AGENTS.md section 8.
- `docs/stack.md` listing the exact pinned versions.
Done when:
- [ ] A fresh clone runs `pnpm install && pnpm typecheck && pnpm lint && pnpm test` green
- [ ] The app starts in Expo Go or a dev build on iOS and Android
- [ ] A PR with a deliberate type error fails CI (show the failed run link)

### F-1 Supabase project, migrations and RLS test harness [safety]
Session: G1 · Depends on: F-0, Supabase account · Review: deep (tests-only PR first)
Branch: `task/f-1-supabase`
Do:
- `supabase/carecircle/` with Supabase CLI config, `migrations/`, `functions/`, `tests/`.
- First migration: `users_profile` table with RLS (a user reads and updates only their own row) and a trigger that creates the row on sign-up.
- pgTAP harness runnable with `pnpm test:db` locally and in CI.
Done when:
- [ ] `supabase start` plus `pnpm test:db` runs in CI
- [ ] pgTAP test proves user A cannot read user B's `users_profile` row, and can read their own

### F-2a ai-gateway core
Session: G1 · Depends on: F-1 · Review: standard
Branch: `task/f-2a-ai-gateway-core`
Do:
- Edge Function `supabase/carecircle/functions/ai/index.ts` implementing the request, success and failure envelopes in spec Part 1 "AI gateway".
- Provider interface, a `fake` provider returning fixtures, `routes.ts` with one entry per task.
- Zod validation of output; one retry on invalid output, then `SCHEMA_INVALID`.
- `ai_calls` logging table (no raw images, audio or text).
- `packages/ai-gateway/client.ts`: typed client the app uses.
Done when:
- [ ] `deno test`: valid fake output returns `ok: true`; invalid output twice returns `SCHEMA_INVALID`; no JWT returns `UNAUTHENTICATED`
- [ ] A row lands in `ai_calls` per call, with no input or output content

### F-2b ai-gateway providers [safety]
Session: G1 · Depends on: F-2a, API keys set as Supabase secrets by Taha · Review: deep
Branch: `task/f-2b-ai-providers`
Do:
- Claude and Gemini provider adapters behind the interface; model per task chosen in `routes.ts`.
- Per-user rate limit (default 60 calls per hour), 25 s timeout returning `PROVIDER_ERROR`.
- Token counts and estimated cost per call in `ai_calls`.
Done when:
- [ ] The same test prompt runs on both providers and validates
- [ ] A search of the app bundle and the repo finds no API key
- [ ] Call 61 in an hour returns `QUOTA_EXCEEDED`

### F-3a Design tokens
Session: G2 · Depends on: F-0 · Review: standard
Branch: `task/f-3a-tokens`
Do: `packages/ui/tokens.ts`: colours for light and dark, spacing on a 4 px grid, type scale, radii. Theme provider that follows the system setting.
Done when:
- [ ] A token preview route renders in light and dark
- [ ] Text colour pairs meet WCAG AA contrast (unit test computing contrast ratios)

### F-3b Shared components
Session: G2 · Depends on: F-3a · Review: standard
Branch: `task/f-3b-components`
Do: `Screen`, `Header`, `Button`, `Card`, `ListRow`, `Chip`, `Sheet`, `EmptyState`, `ErrorState`, `ConfirmDraft` in `packages/ui`, plus a gallery route showing every state.
`ConfirmDraft` takes a list of fields (label, value, confidence), highlights confidence under 0.8, lets the user edit each, and only calls `onConfirm` when the user taps Save.
Done when:
- [ ] Gallery renders every component in every state, light and dark
- [ ] Every interactive element has an accessibility label and a 44 pt minimum target (component tests)
- [ ] `ConfirmDraft` test: `onConfirm` is never called without a Save tap

### F-4 Auth [safety]
Session: G2 · Depends on: F-1 · Review: deep (tests-only PR first)
Branch: `task/f-4-auth`
Do: `packages/core/auth`: Sign in with Apple, Google, email magic link via Supabase Auth; session persistence in secure storage; `/(auth)/sign-in` route; signed-out users are redirected to sign-in.
Done when:
- [ ] Maestro: email magic-link sign-in reaches the signed-in placeholder on iOS and Android
- [ ] Sign out clears the session from secure storage (unit test)
- [ ] No token or email appears in any log or analytics call (test spies on the logger)

### F-5 Paywall on RevenueCat [safety]
Session: G2 · Depends on: F-4, RevenueCat account · Review: deep
Branch: `task/f-5-paywall`
Do: `packages/core/paywall`: `useEntitlement('carecircle_family')`, paywall sheet, restore purchases button. RevenueCat webhook Edge Function writing the `entitlements` table. Server code reads entitlements only from that table.
Done when:
- [ ] Sandbox purchase sets `entitlements.active = true` for the user
- [ ] Restore on a fresh install unlocks the entitlement
- [ ] A forged client claim of entitlement is refused by a server function (test)

### F-6 Notifications
Session: G1 · Depends on: F-1 · Review: standard
Branch: `task/f-6-notifications`
Do: push token registration into `push_tokens`; local schedule helper in `packages/core/notifications`; Edge Function `send-push` that sends to a list of user IDs.
Done when:
- [ ] A local notification and a push both arrive on a real device (screenshot)
- [ ] Helper unit test: scheduling at a local time in a given IANA timezone produces the right UTC trigger

### F-7 Sentry, PostHog and event rules
Session: G1 · Depends on: F-0 · Review: standard
Branch: `task/f-7-analytics`
Do: wrappers in `packages/core/analytics` with a typed list of allowed event names and allowed property keys; anything else is a type error.
Done when:
- [ ] A test crash shows in Sentry and a test event in PostHog
- [ ] Type test: an unlisted event name or property fails to compile

### F-8 Maestro in CI and EAS profiles
Session: G2 · Depends on: F-0 · Review: standard
Branch: `task/f-8-maestro-eas`
Do: Maestro on an Android emulator in GitHub Actions; `eas.json` with `development` and `preview` profiles.
Done when:
- [ ] One Maestro flow runs green in CI
- [ ] A preview build installs on a real Android phone

---

## CareCircle

### CC-0 Contracts C1 and C2 [safety]
Session: G1 · Depends on: foundation done · Review: deep (tests-only PR first); Taha merges
Branch: `task/cc-0-contracts`
Spec: Part 2 "Data model (contract C1)", "AI contracts (contract C2)", "Roles and permissions"
Do:
- Migrations for every C1 table and enum, exactly as written, with RLS per the roles table, and triggers that write `log_entries`.
- `docs/contracts/carecircle-C1.md` and `carecircle-C2.md`: tables, enums and JSON examples copied from the spec.
- Zod schemas: `packages/core/schemas/carecircle.ts` (rows, schedule JSON) and `packages/ai-gateway/schemas/carecircle/{extractPrescription,summarizeVisit}.ts`.
- Mock data (one circle, 3 members, 4 meds, 7 days of dose events, 3 appointments, 5 tasks) and fake AI responses for both tasks.
Done when:
- [ ] Migrations apply cleanly on a fresh database
- [ ] pgTAP for every table: non-member reads 0 rows; viewer insert, update and delete fail; helper cannot create invites or change roles; nobody can update or delete `log_entries`
- [ ] Schedule schema accepts the 4 examples in the spec and rejects an unknown `kind`
- [ ] Mocks load in the app with a `MOCKS=1` flag

### CC-1a Onboarding and create circle
Session: G2 · Depends on: CC-0 mocks, F-4 · Review: standard
Branch: `task/cc-1a-onboarding`
Spec: Screens "Create or join"; APIs `rpc create_circle`
Do: `/(onboarding)/start` with Create and Join; create form (circle name, care recipient name, timezone defaulting to the device); `rpc create_circle`.
Done when:
- [ ] Maestro: a new user signs in, creates a circle and lands on an empty Today screen
- [ ] pgTAP: `create_circle` makes the caller owner in the same transaction
- [ ] `cc_circle_created` fires once

### CC-1b Invites and roles [safety]
Session: G2 · Depends on: CC-1a · Review: deep
Branch: `task/cc-1b-invites`
Spec: Roles and permissions; APIs `create_invite`, `accept_invite`; Screens "Circle settings"
Do: invite link (deep link) creation, sharing, accepting; `/circle` screen listing members with role change and remove (owner only); free plan max 2 members, Family 8.
Done when:
- [ ] Maestro on two devices: second user joins by link and appears in the member list
- [ ] `accept_invite` returns `INVITE_EXPIRED` after 7 days, `INVITE_USED` on reuse, `CIRCLE_FULL` at the plan limit (pgTAP)
- [ ] A viewer sees no edit controls and a direct API write as viewer fails
- [ ] `cc_invite_sent` and `cc_invite_accepted` fire

### CC-2a Dose generator [safety]
Session: G1 · Depends on: CC-0 · Review: deep (tests-only PR first)
Branch: `task/cc-2a-dose-generator`
Spec: Dose engine rules 1, 2, 4, 5
Do: pure function in `apps/carecircle/src/features/meds/logic.ts` (also imported by the Edge Function) turning a medication and a time window into dose times; Edge Function `materialize-doses` scheduled hourly with `pg_cron`; schedule-edit handling.
Done when:
- [ ] Unit tests with a fake clock: daily, weekly, every_n_days, as_needed (no events), DST spring-forward (02:30 fires at 03:00), DST fall-back (01:30 fires once), schedule edit deletes only future `pending` events
- [ ] Running `materialize-doses` twice creates zero duplicates

### CC-2b Missed doses and realtime check-off [safety]
Session: G1 · Depends on: CC-2a, F-6 · Review: deep
Branch: `task/cc-2b-missed-realtime`
Spec: Dose engine rule 3; APIs `set_dose_status`; Realtime
Do: `mark-missed` job every 5 minutes; push via `send-push` to owner and assigned helper; `rpc set_dose_status`; realtime subscription hook.
Done when:
- [ ] A dose `pending` 60 minutes after `due_at` is `missed` after the next run, and one push each is queued for owner and helper
- [ ] `set_dose_status` refuses `missed` and `pending`, and refuses viewers
- [ ] Two clients: a check-off on A shows on B within 2 seconds on Wi-Fi in 9 of 10 runs
- [ ] `cc_dose_given` and `cc_dose_missed` fire

### CC-3a Today screen
Session: G2 · Depends on: CC-0 mocks, F-3b · Review: standard
Branch: `task/cc-3a-today`
Spec: Screens "Today"
Do: `/(tabs)/today` with doses grouped by time, Given and Skip buttons, next appointment, tasks due today; offline cache with queued check-offs.
Done when:
- [ ] Component tests for loading, empty, error and offline states
- [ ] Check-off works on mocks and, offline, is sent when the network returns (test)

### CC-3b Medication screens
Session: G2 · Depends on: CC-3a · Review: standard
Branch: `task/cc-3b-meds`
Spec: Screens "Meds"; schedule JSON
Do: `/(tabs)/meds` list with schedule summary and 7-day adherence; add and edit form (react-hook-form + schedule Zod schema); pause.
Done when:
- [ ] Maestro: add, edit and pause a medication
- [ ] Form rejects an invalid schedule with a visible error
- [ ] `cc_med_added` fires with `source: manual`

### CC-4a Prescription photo: camera and extract
Session: G2 · Depends on: CC-0, F-2b · Review: standard
Branch: `task/cc-4a-photo-extract`
Spec: AI contract `carecircle.extractPrescription`; gateway image rules
Do: `/meds/scan` camera, resize to 1600 px JPEG 0.8, upload to Storage, call the gateway, handle every error code from the gateway table.
Done when:
- [ ] Returns a typed draft from the fake provider and from a real provider
- [ ] Each gateway error code shows the behaviour in the spec table (component tests)

### CC-4b Confirm screen and label test set
Session: G2 · Depends on: CC-4a · Review: standard
Branch: `task/cc-4b-confirm`
Do: `ConfirmDraft` for the extracted fields; save as `source: photo`; `evals/carecircle/labels/` with 20 label images (Taha supplies photos with personal details blurred) and `expected.json`; eval script `pnpm eval:carecircle`.
Done when:
- [ ] At least 90% of fields (name, strength, doseText, schedule) correct after confirm on the 20 labels
- [ ] e2e: no `medications` row exists before Save is tapped
- [ ] `common.notMedicalAdvice` renders on `/meds/scan`

### CC-5a Visit note: record, transcribe, summarise
Session: G1 · Depends on: CC-0, F-2b · Review: standard
Branch: `task/cc-5a-visit-ai`
Spec: AI contract `carecircle.summarizeVisit`
Do: recording (max 10 minutes) and upload; gateway route for speech-to-text then summary; Family plan check server-side.
Done when:
- [ ] The 5-minute audio fixture returns a schema-valid draft in under 15 seconds at p90 over 10 runs on staging
- [ ] A free-plan user gets `QUOTA_EXCEEDED`

### CC-5b Visit note review and save
Session: G1 · Depends on: CC-5a · Review: standard
Branch: `task/cc-5b-visit-review`
Do: `/visit/new` review with each follow-up and med change accepted one by one; saves `visit_notes`, `tasks` with `source: visit_note`, and medication changes.
Done when:
- [ ] Nothing is saved before the user confirms (test)
- [ ] Each accepted `medChanges` item applies the right change; rejected ones change nothing
- [ ] `common.notMedicalAdvice` renders on `/visit/new`; `cc_visit_note_saved` fires

### CC-6a Appointments and calendar
Session: G2 · Depends on: CC-0, F-6 · Review: standard
Branch: `task/cc-6a-appointments`
Do: `/(tabs)/calendar` month and agenda views; add, edit, delete; assign driver; reminders 24 h and 2 h before.
Done when:
- [ ] Maestro: create, edit and delete an appointment
- [ ] Unit test: reminders scheduled at exactly 24 h and 2 h before `starts_at`

### CC-6b Shared tasks
Session: G2 · Depends on: CC-0 · Review: standard
Branch: `task/cc-6b-tasks`
Do: `/(tabs)/tasks` with filter by assignee; add, assign, due date, complete; realtime.
Done when:
- [ ] Two clients: completing a task on A shows on B within 2 seconds
- [ ] Maestro: add, assign and complete a task

### CC-7 Care log and PDF export
Session: G1 · Depends on: CC-2b · Review: standard
Branch: `task/cc-7-log-pdf`
Do: `/log` timeline with filters; Edge Function `export-log` (max 90 days, signed URL valid 1 hour); Family plan only.
Done when:
- [ ] PDF of the fixture circle (30 days) contains the care recipient name, the date range and one line per log entry (text extraction test)
- [ ] A request over 90 days is refused; `cc_log_exported` fires

### CC-8 Family plan paywall and analytics [safety]
Session: G1 · Depends on: F-5, F-7 · Review: deep; Taha merges
Branch: `task/cc-8-paywall`
Do: limits from spec "Roles and permissions" (members, visit-note AI, PDF) enforced server-side; paywall shown at each limit; funnel events.
Done when:
- [ ] Each limit is refused by the server for a free user even with a modified client (tests)
- [ ] Sandbox trial starts; `cc_paywall_viewed` and `cc_trial_started` fire

### CC-10 Delete account, data export, disclaimer [safety]
Session: G1 · Depends on: CC-0 · Review: deep; Taha merges
Branch: `task/cc-10-delete-account`
Spec: Part 1 "Account deletion"
Do: `delete-account` Edge Function; owner must transfer or delete the circle first; data export of the user's own rows as JSON; disclaimer text in onboarding.
Done when:
- [ ] After `delete-account`, a service-role query finds 0 rows with that `user_id` and 0 Storage objects under the user's prefix
- [ ] An owner of a circle with other members is refused until they transfer ownership
