# CareCircle Privacy Policy

**DRAFT, not legal advice, to be checked**

- **Effective date:** `[[TAHA: effective date]]`
- **Controller / Publisher:** `[[TAHA: legal entity or full name]]`, `[[TAHA: postal address]]`
- **Privacy contact email:** `[[TAHA: privacy email]]`

---

## 1. Plain Summary (Includes Health Information)

CareCircle is a family care coordination app for adult children and relatives caring for a parent or loved one. Because you use CareCircle to coordinate medications, dose check-offs, prescription label scans, medical appointments, care tasks, and doctor's visit notes, **CareCircle collects and processes personal data and health information** about the care recipient and the family members in your circle.

We never sell your personal or health data, never use it for advertising, and never send medication names, dosages, or free-text notes to analytics or push-notification providers. Temporary files uploaded for AI reading or PDF export (prescription photos, visit audio recordings, and exported care log PDFs) are automatically deleted within **24 hours**.

---

## 2. Personal and Health Data We Collect, Why, Where It Goes, and How Long It Is Kept

Every statement below is written directly from the CareCircle codebase, with the exact source file(s) listed.

### 2.1 Account and Profile Data (Supabase Auth & Database)

- **What is collected:**
  - Email address or Apple / Google sign-in identifier (`auth.users`, handled via magic-link OTP or OAuth PKCE in `apps/carecircle/src/features/auth/api.ts` and `packages/core/src/auth.ts`).
  - User UUID, optional display name, locale, time zone, and account creation timestamp (`public.users_profile` in `supabase/carecircle/migrations/20261114000001_users_profile.sql`).
  - Co-members who belong to the same care circle can read each other's display name so the app and care log show who recorded a dose, task, or appointment (`public.shares_circle_with` and `users_profile_select_co_member` in `supabase/carecircle/migrations/20261116000001_invites_and_roles.sql`).
- **Why:** To sign you in, enforce Row-Level Security (RLS) per user and per circle, and display your name to your care circle co-members.
- **Where it goes:** Stored in Supabase (PostgreSQL database and Auth service). Encrypted session tokens are stored locally on your device using `expo-secure-store` (`apps/carecircle/src/features/auth/api.ts`, `packages/core/src/auth.ts`).
- **How long it is kept:** Kept while your account remains active. Deleted immediately when you delete your account (`supabase/carecircle/migrations/20261120000001_review_s15_18.sql`, `supabase/carecircle/functions/delete-account/handler.ts`).

### 2.2 Care Circle and Health Coordination Data (Supabase Database)

- **What is collected:**
  - **Circles (`public.circles`):** Circle name, care recipient's name, optional care recipient date of birth, time zone, creator user ID, and creation timestamp (`supabase/carecircle/migrations/20261115000005_carecircle_c1.sql`, `supabase/carecircle/migrations/20261115000006_create_circle.sql`).
  - **Circle memberships and invites (`public.circle_members`, `public.invites`):** User ID, role (`owner`, `helper`, `viewer`), join timestamp, and single-use 7-day invite tokens (`supabase/carecircle/migrations/20261115000005_carecircle_c1.sql`, `supabase/carecircle/migrations/20261116000001_invites_and_roles.sql`).
  - **Health information — Medications (`public.medications`):** Medication name, strength, dose instructions (`dose_text`), schedule JSON (`daily`, `weekly`, `every_n_days`, `as_needed`), optional notes (`instructions`), start/end dates, active status, and source (`manual` or `photo`) (`supabase/carecircle/migrations/20261115000005_carecircle_c1.sql`, `apps/carecircle/src/features/meds/api.ts`).
  - **Health information — Dose events (`public.dose_events`):** Scheduled due time (`due_at`), status (`pending`, `given`, `skipped`, `missed`), which member recorded the dose (`acted_by`), and when (`acted_at`) (`supabase/carecircle/migrations/20261115000005_carecircle_c1.sql`, `supabase/carecircle/migrations/20261116000002_missed_and_realtime.sql`, `supabase/carecircle/functions/materialize-doses/handler.ts`, `supabase/carecircle/functions/mark-missed/handler.ts`).
  - **Health information — Medical appointments (`public.appointments`):** Appointment title, start and end times, optional location, optional assigned driver (`driver_user_id`), and optional notes (`supabase/carecircle/migrations/20261115000005_carecircle_c1.sql`, `apps/carecircle/src/features/calendar/api.ts`).
  - **Care tasks (`public.tasks`):** Task title, optional due date/time, optional assignee (`assignee`), completion timestamp (`done_at`), who completed it (`done_by`), and source (`manual` or `visit_note`) (`supabase/carecircle/migrations/20261115000005_carecircle_c1.sql`, `apps/carecircle/src/features/tasks/api.ts`).
  - **Health information — Doctor's visit notes (`public.visit_notes`):** Optional linked appointment ID, typed or transcribed visit text (`transcript`), confirmed summary (`summary`), author (`created_by`), and timestamp (`supabase/carecircle/migrations/20261115000005_carecircle_c1.sql`, `apps/carecircle/src/features/visit/api.ts`, `apps/carecircle/src/features/visit/screen.tsx`).
  - **Append-only Care Log (`public.log_entries`):** Chronological audit lines (`dose`, `med_change`, `appointment`, `task`, `visit_note`, `member`) written automatically by database triggers (`public.write_audit_log_entry()` in `supabase/carecircle/migrations/20261115000005_carecircle_c1.sql`).
- **Why:** To display and synchronise the shared care plan across all members of your family circle.
- **Where it goes:** Stored in Supabase PostgreSQL protected by Row-Level Security so only members of that circle can read it. On your phone, Today's snapshot is cached in the app's non-backed-up cache folder (`Paths.cache`) for offline viewing, and offline dose check-offs (dose UUIDs and `'given'`/`'skipped'` status only) are queued in `Paths.document` until synced (`apps/carecircle/src/features/today/api.ts`).
- **How long it is kept:**
  - Kept while the care circle exists.
  - When a user who is the **sole member (and owner)** of a circle deletes their account, the circle and all of its medications, dose events, appointments, tasks, visit notes, invites, and care log entries are permanently deleted (`public.delete_own_account` in `supabase/carecircle/migrations/20261120000001_review_s15_18.sql` and `supabase/carecircle/functions/delete-account/handler.ts`).
  - When a member of a **shared circle** (with other surviving family members) deletes their account, their membership row is deleted and their user ID references (`created_by`, `acted_by`, `driver_user_id`, `assignee`, `done_by`, `used_by`, `ref_id`) are cleared to `NULL` so the surviving family keeps its care history without the deleted member's account (`supabase/carecircle/migrations/20261116000006_delete_account_and_export.sql`, `supabase/carecircle/migrations/20261120000001_review_s15_18.sql`).

### 2.3 Temporary Files in Supabase Storage (Deleted Within 24 Hours)

- **Prescription label photos (`prescription-photos` bucket):**
  - **What & Why:** JPEG photo (up to 2 MB) of a prescription label uploaded by an owner or helper to extract a medication draft (`apps/carecircle/src/features/meds/rx-storage.ts`, `apps/carecircle/src/features/meds/scan.tsx`, `supabase/carecircle/migrations/20261115000008_prescription_photos_storage.sql`).
  - **How long it is kept:** Deleted by the app immediately after the AI extraction request returns (`deletePrescriptionPhoto` in `apps/carecircle/src/features/meds/scan.tsx`). If an app crash or network drop prevents immediate deletion, the daily `pg_cron` job `carecircle-cleanup-prescription-photos-daily` (`15 3 * * *` UTC) and `cleanup-prescription-photos` Edge Function permanently delete any photo older than **24 hours** (`supabase/carecircle/migrations/20261115000008_prescription_photos_storage.sql`, `supabase/carecircle/functions/cleanup-prescription-photos/handler.ts`).
- **Doctor's visit audio recordings (`visit-audio` bucket):**
  - **What & Why:** M4A/MP4 audio recording (up to 10 minutes / 10 MB) recorded on the New Visit Note screen so the AI gateway can transcribe and summarise the appointment (`apps/carecircle/src/features/visit/recorder.ts`, `apps/carecircle/src/features/visit/storage.ts`, `supabase/carecircle/migrations/20261116000003_visit_audio_storage.sql`).
  - **How long it is kept:** No client role has `SELECT` access to download audio from `visit-audio`. The `ai` Edge Function deletes the audio object in a `finally` block immediately after speech-to-text transcription finishes (`supabase/carecircle/functions/ai/handler.ts`), and the daily `pg_cron` job `carecircle-cleanup-visit-audio-daily` (`20 3 * * *` UTC) permanently deletes any object older than **24 hours** (`supabase/carecircle/migrations/20261116000003_visit_audio_storage.sql`, `supabase/carecircle/functions/cleanup-prescription-photos/handler.ts`).
- **Exported Care Log PDFs (`log-exports` bucket):**
  - **What & Why:** PDF file (up to 10 MB, covering up to 90 days of `public.log_entries`) generated when a Family-plan circle member taps **Export PDF** on the Care Log screen (`supabase/carecircle/functions/export-log/handler.ts`, `supabase/carecircle/functions/export-log/pdf.ts`, `supabase/carecircle/migrations/20261116000004_log_exports_storage.sql`).
  - **How long it is kept:** No client role can directly read or write `log-exports`. The `export-log` Edge Function returns a signed download URL valid for **1 hour (`3,600` seconds)** (`SIGNED_URL_EXPIRES_IN_SECONDS` in `supabase/carecircle/functions/export-log/handler.ts`), and the daily `pg_cron` job `carecircle-cleanup-log-exports-daily` (`25 3 * * *` UTC) permanently deletes any PDF older than **24 hours** (`supabase/carecircle/migrations/20261116000004_log_exports_storage.sql`, `supabase/carecircle/functions/cleanup-prescription-photos/handler.ts`).
- **Account deletion cleanup:** When a solo circle owner deletes their account, the `delete-account` Edge Function immediately deletes all files under that circle's prefix in `prescription-photos`, `visit-audio`, and `log-exports` via the Storage API (`supabase/carecircle/functions/delete-account/handler.ts`).

### 2.4 AI Processing — Anthropic (Claude) and Google (Gemini)

- **What is sent and why:**
  - **Prescription label extraction (`carecircle.extractPrescription`):** When you scan a prescription photo, the `ai` Edge Function reads the JPEG from `prescription-photos` and sends it to **Anthropic** (`claude-sonnet-4-6`) — with **Google Gemini** (`gemini-2.5-flash`) configured as fallback — to extract a structured JSON draft (`name`, `strength`, `doseText`, `schedule`, `instructions`, `fieldConfidence`, `rawText`) (`supabase/carecircle/functions/ai/handler.ts`, `supabase/carecircle/functions/ai/routes.ts`, `supabase/carecircle/functions/ai/prompts.ts`).
  - **Visit note transcription and summary (`carecircle.summarizeVisit`):** When you summarise a visit note on a Family-plan circle, if you recorded audio, the `ai` Edge Function sends the audio bytes to **Google Gemini** (`gemini-2.5-flash`) for speech-to-text transcription, immediately deletes the audio file from Storage, and sends the transcript (or your typed notes) together with your circle's active medication names and strengths (`knownMeds`) to **Anthropic** (`claude-sonnet-4-6`) — with **Google Gemini** (`gemini-2.5-flash`) as fallback — to produce a structured draft (`summary`, `followUps`, `medChanges`, `questionsToAsk`) (`supabase/carecircle/functions/ai/handler.ts`, `supabase/carecircle/functions/ai/routes.ts`, `supabase/carecircle/functions/ai/prompts.ts`).
- **What is logged in our database (`public.ai_calls`):** Only operational metadata — `request_id`, `user_id`, `task`, `model`, `prompt_version`, `latency_ms`, `input_tokens`, `output_tokens`, `estimated_cost_microcents`, `cost_currency`, `validation_ok`, and `error_code`. Raw photos, audio, transcripts, medication names, and model outputs are **never** stored in `public.ai_calls` (`supabase/carecircle/migrations/20261114000002_ai_calls.sql`, `supabase/carecircle/migrations/20261114000003_ai_calls_cost_microcents.sql`, `supabase/carecircle/functions/ai/handler.ts`). `public.ai_calls` rows cascade-delete when you delete your account.
- **Provider retention:** API requests sent to Anthropic and Google Gemini via commercial API keys are governed by Anthropic's and Google's API data retention policies (neither provider uses commercial API inputs to train foundation models; see `[[TAHA: confirm Anthropic/Google zero-data-retention or standard API retention period]]`).

### 2.5 Crash Reporting — Sentry

- **What is sent and why:** When the app encounters an unexpected crash or error, `@sentry/react-native` sends a scrubbed crash report to Sentry so we can diagnose and fix bugs (`apps/carecircle/src/features/observability/api.ts`, `packages/core/src/analytics.ts`).
- **Privacy safeguards enforced in code (`apps/carecircle/src/features/observability/api.ts` and `packages/core/src/analytics.ts`):**
  - `sendDefaultPii: false`, `replaysSessionSampleRate: 0`, `replaysOnErrorSampleRate: 0`, `attachScreenshot: false`, `attachViewHierarchy: false`, `enableCaptureFailedRequests: false`, and `enableAutoConsoleLogs: false`.
  - When signed in, only your Supabase UUID (`{ id: userId }`) is attached — never your email address or name (`setUser` in `apps/carecircle/src/features/observability/api.ts`).
  - Console breadcrumbs are dropped, HTTP breadcrumb query strings and fragments (which could contain PostgREST filter values) are stripped, and all exception messages, stack frames, and extras pass through `scrubSensitiveText` (which redacts emails, bearer tokens, invite tokens, push tokens, and sensitive key/value fields).

### 2.6 Product Analytics — PostHog (Counts and Enums Only)

- **What is sent and why:** `posthog-react-native` sends strictly validated usage events to PostHog (`https://eu.i.posthog.com` by default) to measure feature reliability and conversion (`apps/carecircle/src/features/observability/api.ts`, `packages/core/src/analytics.ts`).
- **Privacy safeguards enforced in code (`packages/core/src/analytics.ts` and `apps/carecircle/src/features/observability/api.ts`):**
  - Every analytics event is validated against `ALLOWED_ANALYTICS_EVENTS` (`zod` `.strict()` schemas in `packages/core/src/analytics.ts`) before it can be sent:
    - `cc_circle_created`: `{}`
    - `cc_invite_sent`: `{ role: 'helper' | 'viewer' }`
    - `cc_invite_accepted`: `{ role?: 'helper' | 'viewer' }`
    - `cc_med_added`: `{ source: 'photo' | 'manual', scheduleKind: 'daily' | 'weekly' | 'every_n_days' | 'as_needed' }`
    - `cc_rx_scanned`: `{ autoFilledCount: number, lowConfidenceCount: number }`
    - `cc_dose_given`: `{ status: 'given' | 'skipped' }`
    - `cc_dose_missed`: `{ missedCount: number }`
    - `cc_visit_note_saved`: `{ followUps: number, medChanges: number }`
    - `cc_log_exported`: `{ days: number }`
    - `cc_paywall_viewed`: `{ trigger: 'members' | 'visit_note' | 'pdf_export' | 'circles' | 'settings' }`
    - `cc_trial_started`: `{ entitlement: 'carecircle_family' }`
    - `cc_subscribed`: `{ entitlement: 'carecircle_family' }`
  - Medication names, dosages, care recipient names, visit transcripts, and free text are **never** sent to PostHog.
  - Session replay, autocapture, app lifecycle capture, push notification capture, default person properties, and IP geolocation (`disableGeoip: true`) are all disabled (`buildPostHogOptions` in `apps/carecircle/src/features/observability/api.ts`).

### 2.7 Subscriptions — RevenueCat, Apple App Store, and Google Play

- **What is sent and why:** When you sign in, `react-native-purchases` configures RevenueCat with your Supabase user UUID (`appUserID: userId`) to check offerings, process or restore `carecircle_family` subscriptions through Apple In-App Purchase or Google Play Billing, and sync your entitlement status to `public.entitlements` via the `revenuecat-webhook` Edge Function (`apps/carecircle/src/features/paywall/api.ts`, `packages/core/src/paywall.ts`, `supabase/carecircle/functions/revenuecat-webhook/handler.ts`, `supabase/carecircle/migrations/20261115000002_entitlements.sql`).
- **What is stored in `public.entitlements`:** `user_id`, `entitlement` (`'carecircle_family'`), `active` boolean, and `expires_at` timestamp (`supabase/carecircle/migrations/20261115000002_entitlements.sql`). Deleted when you delete your account. Payment instruments (credit cards, Apple Pay, Google Pay) are handled exclusively by Apple or Google.

### 2.8 Push and Local Notifications — Expo Push Service, Apple APNs, and Google FCM

- **What is collected and why:**
  - When you grant notification permission on iOS or Android, the app registers your device's Expo push token (`ExponentPushToken[...]` or `ExpoPushToken[...]`) and platform (`ios` or `android`) in `public.push_tokens` via `public.register_push_token` (`apps/carecircle/src/features/notifications/api.ts`, `supabase/carecircle/migrations/20261115000001_push_tokens.sql`).
  - Scheduled dose, appointment, and task reminders are scheduled locally on your device (`createExpoLocalNotificationAdapter` in `apps/carecircle/src/features/notifications/api.ts`, `apps/carecircle/src/features/calendar/reminders.ts`).
  - When a scheduled dose becomes overdue by more than 60 minutes, `mark-missed` invokes `send-push`, which sends a push notification through the Expo Push API (`https://exp.host/--/api/v2/push/send`) to Apple APNs or Google FCM (`supabase/carecircle/functions/mark-missed/handler.ts`, `supabase/carecircle/functions/send-push/handler.ts`).
- **Privacy-safe notification content:** Both client and server code enforce that notification titles, bodies, and data payloads are strictly neutral (for example, `"Time for a dose"` or `"A dose was missed"`) and **never** contain medication names, strengths, dosages, or diagnoses (`assertSafeNotificationPayload` in `packages/core/src/notifications.ts` and `HEALTH_DETAIL_TEXT_REGEX` in `supabase/carecircle/functions/send-push/handler.ts`).
- **How long push tokens are kept:** Deleted from `public.push_tokens` when you sign out (`unregisterBeforeSignOut` in `apps/carecircle/src/features/notifications/api.ts`), pruned automatically when Expo reports `DeviceNotRegistered` (`supabase/carecircle/functions/send-push/handler.ts`), reassigned if another user signs in on the same device (`public.register_push_token`), and cascade-deleted when you delete your account (`supabase/carecircle/migrations/20261115000001_push_tokens.sql`).

---

## 3. Legal Basis for Processing (GDPR / UK GDPR)

- **Health information (special-category data under GDPR Art. 9):** Medications, dose check-offs, prescription label photos, medical appointments, doctor's visit audio recordings, visit transcripts and summaries, and care log entries include data concerning health under GDPR Art. 9(1). Processing this health data requires **explicit consent** under **GDPR Art. 9(2)(a)** (together with GDPR Art. 6(1)(a) consent and Art. 6(1)(b) performance of a contract).
  - **Where the app asks for explicit consent:** `[[TAHA: consent step — SignInScreen.tsx and OnboardingStartScreen.tsx do not yet include an explicit GDPR Art. 9(2)(a) consent step; add or specify the consent step before launch]]`.
  - **Withdrawing consent:** You can withdraw consent at any time by deleting individual items, leaving a circle, or deleting your account under **Circle Settings > Delete account** (`apps/carecircle/app/circle.tsx`). Withdrawing consent does not affect the lawfulness of processing carried out before withdrawal.
- **Account, circle membership, subscription, and user-enabled notifications (GDPR Art. 6(1)(b)):** Processed as necessary to provide the CareCircle service you requested (signing you in, enforcing circle access rules, delivering missed-dose notifications when you enable push notifications, and managing `carecircle_family` entitlements).
- **Security, rate limiting, scrubbed crash reporting, and counts-only analytics:** Processed under **GDPR Art. 6(1)(f)** legitimate interests in keeping the service reliable and secure (such as per-user AI rate limiting in `supabase/carecircle/functions/ai/handler.ts` and scrubbed crash diagnostics in `apps/carecircle/src/features/observability/api.ts`), or under **GDPR Art. 6(1)(a) / ePrivacy** consent where required by applicable law (`[[TAHA: confirm crash reporting and analytics legal basis / opt-in setting]]`).
- **Legal obligations (GDPR Art. 6(1)(c)):** Subscription payment and tax records are processed by Apple and Google as merchants of record, and where applicable by the publisher to comply with statutory accounting or tax obligations (`[[TAHA: confirm publisher accounting retention obligations]]`).

---

## 4. Transfers Outside the EU / EEA (and UK)

CareCircle uses the service providers below. Where personal or health data is transferred outside the European Economic Area (EEA) or the United Kingdom, transfers rely on an adequacy decision (such as the **EU-U.S. Data Privacy Framework**, where the provider is certified) and/or the European Commission's **Standard Contractual Clauses (SCCs)** (and the UK International Data Transfer Addendum, where applicable):

| Provider | Role in CareCircle | Processing Country / Region | Transfer Safeguard |
| --- | --- | --- | --- |
| **Supabase** (`supabase/carecircle/`) | Database, authentication, temporary file storage, and Edge Functions | `[[TAHA: Supabase project region, e.g. EU (Frankfurt/Ireland) or US]]`; Supabase, Inc. is headquartered in the **United States** | EU Standard Contractual Clauses (SCCs) / Supabase DPA (`[[TAHA: confirm Supabase DPA and hosted region]]`) |
| **Anthropic** (`supabase/carecircle/functions/ai/routes.ts`) | Prescription label photo extraction and visit-note summarisation (`claude-sonnet-4-6`) | **United States** (Anthropic, PBC) | EU Standard Contractual Clauses (SCCs) under Anthropic's Data Processing Addendum (`[[TAHA: confirm Anthropic DPA / SCCs]]`) |
| **Google** (`supabase/carecircle/functions/ai/routes.ts`) | Visit audio speech-to-text transcription and AI fallback (`gemini-2.5-flash`), plus Google Sign-In, Google Play Billing, and FCM on Android | **United States** and Google global cloud regions (`[[TAHA: confirm Gemini API / Google Cloud region]]`) | EU-U.S. Data Privacy Framework and/or EU Standard Contractual Clauses (SCCs) under Google's Data Processing Terms (`[[TAHA: confirm Google DPA / SCCs]]`) |
| **Sentry** (`apps/carecircle/src/features/observability/api.ts`) | Scrubbed crash reporting (UUID and scrubbed stack traces only) | `[[TAHA: confirm Sentry data residency — United States by default unless an EU .de.sentry.io DSN is configured]]` (Functional Software, Inc., **United States**) | EU-U.S. Data Privacy Framework and EU Standard Contractual Clauses (SCCs) under Sentry's DPA (`[[TAHA: confirm Sentry DPA and ingest region]]`) |
| **PostHog** (`apps/carecircle/src/features/observability/api.ts`) | Counts-and-enums product analytics (`DEFAULT_POSTHOG_HOST = 'https://eu.i.posthog.com'`) | **European Union (Frankfurt, Germany)** by default; **United States** if `EXPO_PUBLIC_POSTHOG_HOST` is set to PostHog US Cloud or for support by PostHog, Inc. (USA) | Hosted in the EU by default; EU-U.S. Data Privacy Framework and EU Standard Contractual Clauses (SCCs) under PostHog's DPA if transferred to the US (`[[TAHA: confirm PostHog EU project and DPA]]`) |
| **RevenueCat** (`apps/carecircle/src/features/paywall/api.ts`, `supabase/carecircle/functions/revenuecat-webhook/handler.ts`) | Subscription entitlement verification (`appUserID` UUID and subscription status) | **United States** (RevenueCat, Inc.) | EU-U.S. Data Privacy Framework and EU Standard Contractual Clauses (SCCs) under RevenueCat's DPA (`[[TAHA: confirm RevenueCat DPA]]`) |
| **Expo** (`supabase/carecircle/functions/send-push/handler.ts`) | Push notification relay (`https://exp.host/--/api/v2/push/send`) to Apple APNs and Google FCM (neutral text only, no health details) | **United States** (650 Industries, Inc.) | EU Standard Contractual Clauses (SCCs) / Expo Terms & DPA (`[[TAHA: confirm Expo DPA / transfer terms]]`) |

You may request information about or a copy of the applicable transfer safeguards by contacting `[[TAHA: privacy email]]`.

---

## 5. Exporting Your Data and Deleting Your Account

- **Export your data (JSON):** At any time inside the app, open **Circle Settings > Export my data**. CareCircle calls `public.export_user_data()` (`supabase/carecircle/migrations/20261116000006_delete_account_and_export.sql`) and lets you save or share a `.json` file containing your profile, entitlements, memberships, circles, medications, dose events, appointments, tasks, visit notes, and care log entries (`apps/carecircle/app/circle.tsx`, `apps/carecircle/src/features/circle/api.ts`).
- **Delete your account:** At any time inside the app, open **Circle Settings > Delete account** (`apps/carecircle/app/circle.tsx`, `supabase/carecircle/functions/delete-account/handler.ts`). If you no longer have the app installed, see our deletion instructions page or email `[[TAHA: email]]`.

---

## 6. Your Privacy Rights and Contact

Depending on where you live (including under the GDPR / UK GDPR and applicable US state privacy laws), you have the right to access, export, correct, or delete your personal data, to restrict or object to certain processing, to withdraw your consent at any time, and to lodge a complaint with your local data protection supervisory authority (`[[TAHA: lead supervisory authority, if applicable]]`). You can exercise access/export and deletion directly in the app under **Circle Settings**, or by contacting us at `[[TAHA: privacy email]]`.
