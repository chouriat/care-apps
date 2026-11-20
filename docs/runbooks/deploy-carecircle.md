# CareCircle Deploy Runbook

Operational runbook for deploying CareCircle database migrations, Storage buckets, and Supabase Edge Functions from `main` to the linked hosted Supabase project.

---

## 1. Migrations (`supabase/carecircle/migrations/`)

All 16 migrations in execution order. Everything up to `20261116000002_missed_and_realtime.sql` was included through PR #39; everything after `20261116000002_missed_and_realtime.sql` is from Steps 15–20 (`batch/s15-18` and review PR #53) and is probably not on the hosted project yet (**Taha checks** with `node supabase/carecircle/cli.mjs migration list --linked`).

| Migration File | What It Changes (One Line) | Hosted Project Status |
| --- | --- | --- |
| `20261114000001_users_profile.sql` | Creates `public.users_profile` with own-row `SELECT`/`UPDATE` RLS and the `on_auth_user_created` (`public.handle_new_user()`) sign-up trigger. | Probably already applied (Taha checks) |
| `20261114000002_ai_calls.sql` | Creates `public.ai_calls` metadata-only AI audit table with RLS enabled and `service_role`-only access. | Probably already applied (Taha checks) |
| `20261114000003_ai_calls_cost_microcents.sql` | Renames `ai_calls.estimated_cost_cents` to `bigint estimated_cost_microcents` and adds `cost_currency` (`USD`). | Probably already applied (Taha checks) |
| `20261115000001_push_tokens.sql` | Creates `public.push_tokens` (`token` PK), own-row `SELECT`/`DELETE` RLS policies, and `public.register_push_token(p_token, p_platform)` RPC. | Probably already applied (Taha checks) |
| `20261115000002_entitlements.sql` | Creates `public.entitlements` (`(user_id, entitlement)` PK) with own-row `SELECT` RLS for `authenticated` and write access for `service_role`. | Probably already applied (Taha checks) |
| `20261115000005_carecircle_c1.sql` | Creates `member_role`, `dose_status`, and `log_type` enums, all 9 domain tables (`circles`, `circle_members`, `invites`, `medications`, `dose_events`, `appointments`, `tasks`, `visit_notes`, `log_entries`), RLS policies, `is_circle_member`/`has_circle_role` helpers, and audit/integrity triggers (`prevent_ownerless_circle`, `check_circle_people`, `prevent_log_entries_mutation`, `write_audit_log_entry`). | Probably already applied (Taha checks) |
| `20261115000006_create_circle.sql` | Creates `public.create_circle` `SECURITY DEFINER` RPC validating IANA time zones, enforcing the 1-owned-circle limit (`CIRCLE_LIMIT_REACHED`), and atomically inserting the circle and `owner` membership row. | Probably already applied (Taha checks) |
| `20261115000007_dose_generator.sql` | Creates `public.reconcile_medication_schedule_edit()` trigger on `public.medications` and schedules the hourly `carecircle-materialize-doses-hourly` (`0 * * * *`) `pg_cron` + `pg_net` job. | Probably already applied (Taha checks) |
| `20261115000008_prescription_photos_storage.sql` | Creates private `prescription-photos` Storage bucket (2 MB JPEG), `prescription_photo_circle_id`, `storage.objects` RLS policies for `owner`/`helper`, `list_expired_prescription_photos` RPC, and daily `carecircle-cleanup-prescription-photos-daily` (`15 3 * * *`) `pg_cron` job. | Probably already applied (Taha checks) |
| `20261116000001_invites_and_roles.sql` | Creates `public.create_invite` and `public.accept_invite` RPCs, `public.shares_circle_with(uuid)` helper, and `users_profile_select_co_member` RLS policy. | Applied in PR #39 deploy (Taha checks) |
| `20261116000002_missed_and_realtime.sql` | Revokes direct `UPDATE` on `public.dose_events` from `authenticated`, creates `public.set_dose_status` RPC, schedules the 5-minute `carecircle-mark-missed` (`*/5 * * * *`) `pg_cron` job, and adds `public.dose_events` to `supabase_realtime`. | Applied in PR #39 deploy (Taha checks) |
| `20261116000003_visit_audio_storage.sql` | Creates private `visit-audio` Storage bucket (10 MB `audio/mp4`, `audio/m4a`), `visit_audio_circle_id`, `storage.objects` `INSERT`/`DELETE` RLS policies for `owner`/`helper` (no client `SELECT`), `list_expired_visit_audio` RPC, and daily `carecircle-cleanup-visit-audio-daily` (`20 3 * * *`) `pg_cron` job. | **Probably not on hosted project yet** (Taha checks) |
| `20261116000004_log_exports_storage.sql` | Creates private `log-exports` Storage bucket (10 MB `application/pdf`, `service_role` only with no client RLS policies), `list_expired_log_exports` RPC, and daily `carecircle-cleanup-log-exports-daily` (`25 3 * * *`) `pg_cron` job. | **Probably not on hosted project yet** (Taha checks) |
| `20261116000005_cc8_plan_limits.sql` | Adds `public.circle_has_family_plan(uuid)`, enforces the 8-member hard ceiling on `public.create_invite`, and routes `public.accept_invite` plan checks through `circle_has_family_plan`. | **Probably not on hosted project yet** (Taha checks) |
| `20261116000006_delete_account_and_export.sql` | Updates `prevent_ownerless_circle`, `prevent_log_entries_mutation`, and `write_audit_log_entry` for account deletion and ownership transfer, and creates `public.transfer_ownership`, `public.export_user_data`, and `public.delete_own_account` RPCs. | **Probably not on hosted project yet** (Taha checks) |
| `20261120000001_review_s15_18.sql` | Revokes `public.circle_has_family_plan(uuid)` from `authenticated` (callable by `accept_invite` and `service_role`), enforces the 1-owned-circle limit (`CIRCLE_LIMIT_REACHED`) in `public.transfer_ownership`, and updates `public.delete_own_account` to check the JWT role (`service_role`) and leave Storage file deletion to the `delete-account` Edge Function via the Storage API. | **Probably not on hosted project yet** (Taha checks) |

---

## 2. Edge Functions (`supabase/carecircle/functions/`)

| Edge Function | `verify_jwt` in `config.toml` | Why `verify_jwt` Is Set This Way | Secrets Read (`Deno.env.get`) | Called by `pg_cron`? (Schedule) |
| --- | --- | --- | --- | --- |
| `ai` | `true` (default; omitted in `config.toml`) | Called only by signed-in mobile app users; both the Supabase Edge gateway and `defaultVerifyJwt` (`GET /auth/v1/user`) verify the user's Bearer JWT before checking circle membership/role and Family plan entitlement. | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `CARECIRCLE_CI_FAKE_AI` | No |
| `cleanup-prescription-photos` | `false` | Invoked by `pg_cron` (`pg_net`) using `Authorization: Bearer <service_role_key>` from Vault rather than a user session JWT; the handler verifies the bearer token against `SUPABASE_SERVICE_ROLE_KEY` in constant time. | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Yes — 3 daily UTC jobs: `carecircle-cleanup-prescription-photos-daily` (`15 3 * * *`, body `{}`), `carecircle-cleanup-visit-audio-daily` (`20 3 * * *`, body `{"includeVisitAudio":true}`), `carecircle-cleanup-log-exports-daily` (`25 3 * * *`, body `{"bucket":"log-exports"}`) |
| `delete-account` | `false` | Gateway JWT check is off so the handler itself validates the caller's Bearer token via `GET /auth/v1/user` and always returns CareCircle's structured `{ ok: false, code: "UNAUTHENTICATED", error: ... }` `401` JSON envelope on missing or invalid tokens. | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | No |
| `export-log` | `true` (default; omitted in `config.toml`) | Called only by signed-in circle members (`owner`, `helper`, or `viewer`); both the Edge gateway and `createDefaultVerifyJwt` (`GET /auth/v1/user`) verify the user's JWT before checking circle membership and Family plan entitlement. | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | No |
| `mark-missed` | `false` | Invoked by `pg_cron` (`pg_net`) with `Authorization: Bearer <cron_secret>`, which is not a JWT; the handler verifies `CRON_SECRET` in constant time. | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET` | Yes — `carecircle-mark-missed` every 5 minutes (`*/5 * * * *`) |
| `materialize-doses` | `false` | Invoked by `pg_cron` (`pg_net`) and by the `medications_reconcile_schedule_edit` database trigger with `Authorization: Bearer <cron_secret>`, which is not a JWT; the handler verifies `CRON_SECRET` in constant time. | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET` | Yes — `carecircle-materialize-doses-hourly` every hour (`0 * * * *`), plus on-demand via `pg_net` when `public.medications` rows are inserted or their schedule/active/date columns change |
| `revenuecat-webhook` | `false` | Called externally by RevenueCat's webhook delivery service using `Authorization: Bearer <REVENUECAT_WEBHOOK_SECRET>`, not a Supabase JWT; the handler verifies `REVENUECAT_WEBHOOK_SECRET` (minimum 32 chars) in constant time. | `REVENUECAT_WEBHOOK_SECRET`, `REVENUECAT_SECRET_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `REVENUECAT_ALLOW_SANDBOX` | No |
| `send-push` | `true` (default; omitted in `config.toml`) | Internal server-to-server function called by `mark-missed` with `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>` (a valid project-signed Supabase JWT that passes gateway verification and the handler's constant-time `SUPABASE_SERVICE_ROLE_KEY` check). | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `EXPO_ACCESS_TOKEN` | No (called by `mark-missed` when due doses transition to `missed`) |

---

## 3. Secrets (Names and Sources Only)

> Never print or commit secret values. Check configured Edge Function secret names and hashes with `node supabase/carecircle/cli.mjs secrets list`.

| Secret Name | Store / Location | Where Its Value Comes From |
| --- | --- | --- |
| `SUPABASE_URL` | Edge Function env (auto-injected by Supabase) | Supabase Dashboard > Project Settings > API > Project URL (`https://<project-ref>.supabase.co`). |
| `SUPABASE_ANON_KEY` | Edge Function env (auto-injected by Supabase) | Supabase Dashboard > Project Settings > API > Project API keys > `anon` `public`. |
| `SUPABASE_SERVICE_ROLE_KEY` | Edge Function env (auto-injected by Supabase) | Supabase Dashboard > Project Settings > API > Project API keys > `service_role` `secret`. |
| `ANTHROPIC_API_KEY` | Edge Function secret (`supabase secrets set`) | Anthropic Console > API Keys (used by `ai` for `carecircle.extractPrescription` and `carecircle.summarizeVisit`). |
| `GEMINI_API_KEY` | Edge Function secret (`supabase secrets set`) | Google AI Studio / Google Cloud Console > Gemini API Keys (used by `ai` for `carecircle.summarizeVisit` speech-to-text transcription and fallback). |
| `CRON_SECRET` | Edge Function secret (`supabase secrets set`) | Random 32+ byte secret generated by Taha (e.g. `openssl rand -hex 32`), matching the `cron_secret` entry in Supabase Vault (`vault.decrypted_secrets`). |
| `REVENUECAT_WEBHOOK_SECRET` | Edge Function secret (`supabase secrets set`) | Random 32+ character bearer secret generated by Taha and pasted into RevenueCat Dashboard > Project > Integrations > Webhooks > Authorization header (`Bearer <secret>`). |
| `REVENUECAT_SECRET_API_KEY` | Edge Function secret (`supabase secrets set`) | RevenueCat Dashboard > Project Settings > API Keys > Secret API key (`sk_...`) used by `revenuecat-webhook` to call `GET /v1/subscribers/{app_user_id}`. |
| `REVENUECAT_ALLOW_SANDBOX` | Edge Function secret (`supabase secrets set`) | Set to `true` on the test Supabase project so sandbox store purchases grant `carecircle_family`; set to `false` (or unset) in production. |
| `EXPO_ACCESS_TOKEN` | Edge Function secret (`supabase secrets set`) | Expo Dashboard (expo.dev) > Account Settings > Access Tokens (used by `send-push` when calling `https://exp.host/--/api/v2/push/send`). |
| `CARECIRCLE_CI_FAKE_AI` | Local CI env only (never set on hosted Supabase) | Set to `1` only in `.github/workflows/ci.yml` for local CI (`http://127.0.0.1:54321` / `http://kong:8000`). Ignored on hosted Supabase URLs. |
| `project_url` | Supabase Vault (`vault.decrypted_secrets`) | Same value as `SUPABASE_URL` (`https://<project-ref>.supabase.co`), read by `pg_cron` and `reconcile_medication_schedule_edit()` to build Edge Function URLs. |
| `cron_secret` | Supabase Vault (`vault.decrypted_secrets`) | Same value as `CRON_SECRET`, read by `carecircle-materialize-doses-hourly`, `carecircle-mark-missed`, and `reconcile_medication_schedule_edit()`. |
| `service_role_key` | Supabase Vault (`vault.decrypted_secrets`) | Same value as `SUPABASE_SERVICE_ROLE_KEY`, read by the three daily Storage cleanup `pg_cron` jobs (`carecircle-cleanup-prescription-photos-daily`, `carecircle-cleanup-visit-audio-daily`, `carecircle-cleanup-log-exports-daily`). |

---

## 4. Storage Buckets

All three buckets are **private** (`public = false`) and store files under `<circle_id>/<uuid>.<ext>`.

| Bucket ID | Size Limit | Allowed File Types | Who May Read and Write | How Long Files Live |
| --- | --- | --- | --- | --- |
| `prescription-photos` | `2,097,152` bytes (2 MB) | `image/jpeg` (`.jpg` at `<circle_id>/<uuid>.jpg`) | **Write (`INSERT`, `DELETE`) & Read (`SELECT`):** `authenticated` users who have role `owner` or `helper` in `<circle_id>` (enforced by RLS on `storage.objects` via `public.prescription_photo_circle_id(name)`). No `UPDATE` policy; `viewer` and non-members have no access. `service_role` (`ai`, `cleanup-prescription-photos`, `delete-account`) reads and deletes via Storage API. | Deleted by the app as soon as `extractPrescription` finishes, deleted by `delete-account` when a solo circle is deleted, and swept within **24 hours** of `created_at` by `carecircle-cleanup-prescription-photos-daily` (`15 3 * * *` UTC). |
| `visit-audio` | `10,485,760` bytes (10 MB) | `audio/mp4`, `audio/m4a` (`.m4a` at `<circle_id>/<uuid>.m4a`) | **Write (`INSERT`, `DELETE`):** `authenticated` users who have role `owner` or `helper` in `<circle_id>` (via `public.visit_audio_circle_id(name)`). **Read (`SELECT`):** no client role can download audio (`SELECT` policy only permits row lookup inside a Storage `DELETE` transaction when `storage.allow_delete_query = 'true'`). Only `service_role` (`ai` after membership + Family plan checks, `cleanup-prescription-photos`, `delete-account`) reads or deletes audio. | Deleted immediately by the `ai` Edge Function in a `finally` block right after speech-to-text transcription finishes, deleted by `delete-account` when a solo circle is deleted, and swept within **24 hours** of `created_at` by `carecircle-cleanup-visit-audio-daily` (`20 3 * * *` UTC). |
| `log-exports` | `10,485,760` bytes (10 MB) | `application/pdf` (`.pdf` at `<circle_id>/<uuid>.pdf`) | **Write & Read:** no RLS policies exist for `authenticated` or `anon` on `storage.objects` for `log-exports`; no client can directly read or write the bucket. Only `service_role` (`export-log` after verifying circle membership and Family plan) uploads the generated PDF and mints a signed download URL (`3,600` seconds) for the requesting member (`owner`, `helper`, or `viewer`). | Signed download URL expires after **1 hour (`3,600` seconds)**; files are deleted by `delete-account` when a solo circle is deleted, and swept within **24 hours** of `created_at` by `carecircle-cleanup-log-exports-daily` (`25 3 * * *` UTC). |

---

## 5. Deploy Commands in Order and Dashboard Checks

Run all deploy commands from the repository root on a clean checkout of `main`.

### Step 5.1 — Check linked migration status and configured secret names

```bash
node supabase/carecircle/cli.mjs migration list --linked
node supabase/carecircle/cli.mjs secrets list
```

Verify that all required Edge Function secrets in Section 3 are present (names and hashes only) and that Vault secrets `project_url`, `cron_secret`, and `service_role_key` exist in `vault.decrypted_secrets`.

### Step 5.2 — Push pending database migrations

```bash
node supabase/carecircle/cli.mjs db push --linked
```

### Step 5.3 — Deploy each Edge Function in order

`node supabase/carecircle/cli.mjs` stages `supabase/carecircle/config.toml` into the temporary workdir before invoking `supabase`. Pass `--no-verify-jwt` explicitly on the five functions where `verify_jwt = false` in `config.toml` so the hosted flag always matches `config.toml`:

```bash
node supabase/carecircle/cli.mjs functions deploy ai
node supabase/carecircle/cli.mjs functions deploy cleanup-prescription-photos --no-verify-jwt
node supabase/carecircle/cli.mjs functions deploy delete-account --no-verify-jwt
node supabase/carecircle/cli.mjs functions deploy export-log
node supabase/carecircle/cli.mjs functions deploy mark-missed --no-verify-jwt
node supabase/carecircle/cli.mjs functions deploy materialize-doses --no-verify-jwt
node supabase/carecircle/cli.mjs functions deploy revenuecat-webhook --no-verify-jwt
node supabase/carecircle/cli.mjs functions deploy send-push
```

### Step 5.4 — Dashboard checks

In **Supabase Dashboard > Edge Functions**, inspect each deployed function's details page and confirm **"Enforce JWT verification"** matches `supabase/carecircle/config.toml`:

- **Enforce JWT verification = OFF (`verify_jwt = false`):**
  - `cleanup-prescription-photos`
  - `delete-account`
  - `mark-missed`
  - `materialize-doses`
  - `revenuecat-webhook`
- **Enforce JWT verification = ON (`verify_jwt = true`):**
  - `ai`
  - `export-log`
  - `send-push`

In **Supabase Dashboard > Storage**, confirm the three private buckets exist with their limits:
- `prescription-photos` (Private, `2 MB`, `image/jpeg`)
- `visit-audio` (Private, `10 MB`, `audio/mp4`, `audio/m4a`)
- `log-exports` (Private, `10 MB`, `application/pdf`)

---

## 6. Rollback Plan for Each New Migration

Because merged migrations are never edited or deleted, any rollback is applied as a new forward compensating SQL migration (or executed in the SQL Editor followed by `supabase migration repair --status reverted <version>` if rolling back immediately during a failed deploy window).

### 6.1 Undo `20261120000001_review_s15_18.sql`
- **How to undo:**
  1. Re-run the `create or replace function` and `grant execute` statements from `20261116000005_cc8_plan_limits.sql` for `public.circle_has_family_plan(uuid)` (re-granting `execute` to `authenticated, service_role`).
  2. Re-run the `create or replace function` definitions from `20261116000006_delete_account_and_export.sql` for `public.transfer_ownership(uuid, uuid)` and `public.delete_own_account(uuid)`.
- **Data loss:** **No data is lost** (function definitions and grants only). Note: rolling back `20261120000001_review_s15_18.sql` would re-introduce the security and Storage cleanup bugs fixed in PR #53, so do not roll it back independently unless also rolling back `20261116000005` and `20261116000006`.

### 6.2 Undo `20261116000006_delete_account_and_export.sql`
- **How to undo:**
  ```sql
  drop function if exists public.delete_own_account(uuid);
  drop function if exists public.export_user_data();
  drop function if exists public.transfer_ownership(uuid, uuid);
  ```
  Then restore the original `public.prevent_ownerless_circle()`, `public.prevent_log_entries_mutation()`, and `public.write_audit_log_entry()` function bodies from `20261115000005_carecircle_c1.sql`.
- **Data loss:** **No data is lost** (drops RPCs and restores trigger functions only; no tables or columns are dropped).

### 6.3 Undo `20261116000005_cc8_plan_limits.sql`
- **How to undo:**
  Re-run the `create or replace function` statements for `public.create_invite(uuid, public.member_role)` and `public.accept_invite(text)` from `20261116000001_invites_and_roles.sql`, then drop the helper:
  ```sql
  drop function if exists public.circle_has_family_plan(uuid);
  ```
- **Data loss:** **No data is lost** (function definitions only).

### 6.4 Undo `20261116000004_log_exports_storage.sql`
- **How to undo:**
  1. Empty the `log-exports` bucket via the Storage API (`DELETE /storage/v1/object/log-exports`).
  2. Unschedule the cron job, drop the helper RPC, and remove the bucket row:
     ```sql
     select cron.unschedule('carecircle-cleanup-log-exports-daily');
     drop function if exists public.list_expired_log_exports(integer);
     delete from storage.buckets where id = 'log-exports';
     ```
- **Data loss:** **Loses any temporary care-log export PDFs currently stored in `log-exports`** (these are transient 24-hour files generated on demand from `public.log_entries`; the underlying care log rows in `public.log_entries` are untouched).

### 6.5 Undo `20261116000003_visit_audio_storage.sql`
- **How to undo:**
  1. Empty the `visit-audio` bucket via the Storage API (`DELETE /storage/v1/object/visit-audio`).
  2. Unschedule the cron job, drop the `storage.objects` policies and helper functions, and remove the bucket row:
     ```sql
     select cron.unschedule('carecircle-cleanup-visit-audio-daily');
     drop function if exists public.list_expired_visit_audio(integer);
     drop policy if exists visit_audio_insert_owner_helper on storage.objects;
     drop policy if exists visit_audio_select_for_delete_owner_helper on storage.objects;
     drop policy if exists visit_audio_delete_owner_helper on storage.objects;
     drop function if exists public.visit_audio_circle_id(text);
     delete from storage.buckets where id = 'visit-audio';
     ```
- **Data loss:** **Loses any in-flight visit-note `.m4a` audio recordings currently in `visit-audio`** (transient recordings awaiting transcription; saved visit notes in `public.visit_notes` are untouched).
