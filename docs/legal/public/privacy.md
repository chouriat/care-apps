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

### 2.1 Account and Profile Data (Supabase Auth & Database)

- **What is collected:**
  - Email address or Apple / Google sign-in identifier (via magic-link sign-in or Apple / Google sign-in).
  - Account identifier, optional display name, locale, time zone, and account creation date and time.
  - Co-members who belong to the same care circle can read each other's display name so the app and care log show who recorded a dose, task, or appointment.
- **Why:** To sign you in, enforce per-user and per-circle access rules, and display your name to your care circle co-members.
- **Where it goes:** Stored in Supabase (database and authentication service). Encrypted session tokens are stored locally in your device's secure storage.
- **How long it is kept:** Kept while your account remains active. Deleted immediately when you delete your account.

### 2.2 Care Circle and Health Coordination Data (Supabase Database)

- **What is collected:**
  - **Circles:** Circle name, care recipient's name, optional care recipient date of birth, time zone, creator account identifier, and creation timestamp.
  - **Circle memberships and invites:** Member account identifier, role (Owner, Helper, or Viewer), join timestamp, and single-use 7-day invite links.
  - **Health information — Medications:** Medication name, strength, dose instructions, schedule (daily, weekly, every N days, or as-needed), optional notes, start and end dates, active status, and whether the medication was entered manually or from a label photo.
  - **Health information — Dose events:** Scheduled due time, status (pending, given, skipped, or missed), which member recorded the dose, and when.
  - **Health information — Medical appointments:** Appointment title, start and end times, optional location, optional assigned driver, and optional notes.
  - **Care tasks:** Task title, optional due date and time, optional assigned family member, completion timestamp, who completed it, and whether it was created manually or from a visit note.
  - **Health information — Doctor's visit notes:** Optional linked appointment, typed or transcribed visit text, confirmed summary, author, and creation timestamp.
  - **Append-only Care Log:** Chronological activity entries (doses, medication changes, appointments, tasks, visit notes, and member changes) recorded automatically when circle activity occurs.
- **Why:** To display and synchronise the shared care plan across all members of your family circle.
- **Where it goes:** Stored in our Supabase database protected by access controls so only members of that circle can read it. On your phone, Today's schedule is cached in the app's local cache folder for offline viewing, and offline dose check-offs (dose identifiers and given/skipped status only) are stored locally until synced.
- **How long it is kept:**
  - Kept while the care circle exists.
  - When a user who is the **sole member (and owner)** of a circle deletes their account, the circle and all of its medications, dose events, appointments, tasks, visit notes, invites, and care log entries are permanently deleted.
  - When a member of a **shared circle** (with other surviving family members) deletes their account, their membership is deleted and their user identifier references on historical items are cleared so the surviving family keeps its care history without the deleted member's account.

### 2.3 Temporary Files in Supabase Storage (Deleted Within 24 Hours)

- **Prescription label photos:**
  - **What & Why:** JPEG photo (up to 2 MB) of a prescription label uploaded by an Owner or Helper to extract a medication draft.
  - **How long it is kept:** Deleted by the app immediately after the AI extraction request returns. If an app crash or network drop prevents immediate deletion, an automated daily cleanup permanently deletes any photo older than **24 hours**.
- **Doctor's visit audio recordings:**
  - **What & Why:** Audio recording (M4A/MP4, up to 10 minutes / 10 MB) recorded on the New Visit Note screen so our server can transcribe and summarise the appointment.
  - **How long it is kept:** No client device can download audio recordings from cloud storage. Our AI service deletes the audio file immediately after speech-to-text transcription finishes, and an automated daily cleanup permanently deletes any recording older than **24 hours**.
- **Exported Care Log PDFs:**
  - **What & Why:** PDF file (up to 10 MB, covering up to 90 days of care log entries) generated when a Family Plan circle member taps **Export PDF** on the Care Log screen.
  - **How long it is kept:** Our export service returns a temporary signed download link valid for **1 hour (3,600 seconds)**, and an automated daily cleanup permanently deletes any exported PDF older than **24 hours**.
- **Account deletion cleanup:** When a solo circle owner deletes their account, all temporary prescription photos, visit audio recordings, and exported PDFs belonging to that circle are immediately deleted from cloud storage.

### 2.4 AI Processing — Anthropic (Claude) and Google (Gemini)

- **What is sent and why:**
  - **Prescription label extraction:** When you scan a prescription photo, our server reads the JPEG photo and sends it to **Anthropic** (Claude) — with **Google** (Gemini) configured as fallback — to extract a structured medication draft (name, strength, dose instructions, schedule, notes, field confidence, and label text).
  - **Visit note transcription and summary:** When you summarise a visit note on a Family Plan circle, if you recorded audio, our server sends the audio recording to **Google** (Gemini) for speech-to-text transcription, immediately deletes the audio file from storage, and sends the transcript (or your typed notes) together with your circle's active medication names and strengths to **Anthropic** (Claude) — with **Google** (Gemini) as fallback — to produce a structured draft (summary, follow-up tasks, medication changes, and questions to ask).
- **What is logged in our database:** Only operational metadata — request identifier, user identifier, task type, model name, prompt version, latency, input and output token counts, estimated cost, validation status, and error code. Raw photos, audio, transcripts, medication names, and model outputs are **never** stored in our AI operational logs, and those logs are deleted when you delete your account.
- **Provider retention:** API requests sent to Anthropic and Google via commercial API keys are governed by Anthropic's and Google's commercial API data retention policies (neither provider uses commercial API inputs to train foundation models; see `[[TAHA: confirm Anthropic/Google zero-data-retention or standard API retention period]]`).

### 2.5 Crash Reporting — Sentry

- **What is sent and why:** When the app encounters an unexpected crash or error, the app sends a scrubbed crash report to Sentry so we can diagnose and fix bugs.
- **Privacy safeguards:**
  - Default personal data collection, session replays, screenshots, view hierarchies, failed network body capture, and automatic console log capture are all turned off.
  - When signed in, only your internal account identifier is attached — never your email address or name.
  - Console breadcrumbs are dropped, network query strings and URL fragments are stripped, and exception messages and stack traces are scrubbed to redact email addresses, authentication tokens, invite links, push tokens, and sensitive fields before leaving your device.

### 2.6 Product Analytics — PostHog (Counts and Enums Only)

- **What is sent and why:** CareCircle sends strictly validated usage counts and category values to PostHog to understand feature reliability and subscription conversion:
  - Circle created, invite sent or accepted (role category only), medication added (photo vs manual and schedule type only), prescription scanned (counts of auto-filled and low-confidence fields only), dose recorded (given vs skipped status only), missed-dose count, visit note saved (counts of follow-up tasks and medication changes only), care log exported (number of days only), paywall viewed (screen trigger category only), and trial started or subscribed.
- **Privacy safeguards:**
  - Medication names, dosages, care recipient names, visit transcripts, and free text are **never** sent to PostHog.
  - Session replay, autocapture, app lifecycle capture, push notification capture, default person properties, and IP geolocation lookup are all disabled.

### 2.7 Subscriptions — RevenueCat, Apple App Store, and Google Play

- **What is sent and why:** When you sign in, CareCircle uses RevenueCat with your internal account identifier to display subscription options, process or restore CareCircle Family Plan subscriptions through Apple In-App Purchase or Google Play Billing, and keep your subscription status synchronised on our server.
- **What we store:** Your internal account identifier, plan entitlement name, active status, and expiration date. Deleted when you delete your account. Payment details (credit cards, Apple Pay, Google Pay) are handled exclusively by Apple or Google.

### 2.8 Push and Local Notifications — Expo Push Service, Apple APNs, and Google FCM

- **What is collected and why:**
  - When you grant notification permission on iOS or Android, the app registers your device's push notification token and platform (iOS or Android) on our server.
  - Scheduled dose, appointment, and task reminders are scheduled locally on your device.
  - When a scheduled dose becomes overdue by more than 60 minutes, our server sends a push notification through the Expo Push Service to Apple Push Notification service (APNs) or Google Firebase Cloud Messaging (FCM).
- **Privacy-safe notification content:** Notification titles, messages, and data payloads are strictly neutral (for example, `"Time for a dose"` or `"A dose was missed"`) and **never** contain medication names, strengths, dosages, or diagnoses.
- **How long push tokens are kept:** Deleted from our server when you sign out, removed automatically when a device unregisters notifications, reassigned if another user signs in on the same device, and deleted immediately when you delete your account.

---

## 3. Legal Basis for Processing (GDPR / UK GDPR)

- **Health information (special-category data under GDPR Art. 9):** Medications, dose check-offs, prescription label photos, medical appointments, doctor's visit audio recordings, visit transcripts and summaries, and care log entries include data concerning health under GDPR Art. 9(1). Processing this health data requires **explicit consent** under **GDPR Art. 9(2)(a)** (together with GDPR Art. 6(1)(a) consent and Art. 6(1)(b) performance of a contract).
  - **Where the app asks for explicit consent:** `[[TAHA: consent step]]`.
  - **Withdrawing consent:** You can withdraw consent at any time by deleting individual items, leaving a circle, or deleting your account under **Circle Settings > Delete account**. Withdrawing consent does not affect the lawfulness of processing carried out before withdrawal.
- **Account, circle membership, subscription, and user-enabled notifications (GDPR Art. 6(1)(b)):** Processed as necessary to provide the CareCircle service you requested (signing you in, enforcing circle access rules, delivering missed-dose notifications when you enable push notifications, and managing Family Plan subscriptions).
- **Security, rate limiting, scrubbed crash reporting, and counts-only analytics:** Processed under **GDPR Art. 6(1)(f)** legitimate interests in keeping the service reliable and secure (such as per-user AI rate limiting and scrubbed crash diagnostics), or under **GDPR Art. 6(1)(a) / ePrivacy** consent where required by applicable law (`[[TAHA: confirm crash reporting and analytics legal basis / opt-in setting]]`).
- **Legal obligations (GDPR Art. 6(1)(c)):** Subscription payment and tax records are processed by Apple and Google as merchants of record, and where applicable by the publisher to comply with statutory accounting or tax obligations (`[[TAHA: confirm publisher accounting retention obligations]]`).

---

## 4. Transfers Outside the EU / EEA (and UK)

CareCircle uses the service providers below. Where personal or health data is transferred outside the European Economic Area (EEA) or the United Kingdom, transfers rely on an adequacy decision (such as the **EU-U.S. Data Privacy Framework**, where the provider is certified) and/or the European Commission's **Standard Contractual Clauses (SCCs)** (and the UK International Data Transfer Addendum, where applicable):

| Provider | Role in CareCircle | Processing Country / Region | Transfer Safeguard |
| --- | --- | --- | --- |
| **Supabase** | Database, authentication, temporary file storage, and backend functions | `[[TAHA: Supabase project region, e.g. EU (Frankfurt/Ireland) or US]]`; Supabase, Inc. is headquartered in the **United States** | EU Standard Contractual Clauses (SCCs) / Supabase Data Processing Addendum (`[[TAHA: confirm Supabase DPA and hosted region]]`) |
| **Anthropic** | Prescription label photo extraction and visit-note summarisation (Claude) | **United States** (Anthropic, PBC) | EU Standard Contractual Clauses (SCCs) under Anthropic's Data Processing Addendum (`[[TAHA: confirm Anthropic DPA / SCCs]]`) |
| **Google** | Visit audio speech-to-text transcription and AI fallback (Gemini), plus Google Sign-In, Google Play Billing, and FCM on Android | **United States** and Google global cloud regions (`[[TAHA: confirm Gemini API / Google Cloud region]]`) | EU-U.S. Data Privacy Framework and/or EU Standard Contractual Clauses (SCCs) under Google's Data Processing Terms (`[[TAHA: confirm Google DPA / SCCs]]`) |
| **Sentry** | Scrubbed crash reporting (internal account identifier and scrubbed stack traces only) | `[[TAHA: confirm Sentry data residency — United States or European Union]]` (Functional Software, Inc., **United States**) | EU-U.S. Data Privacy Framework and EU Standard Contractual Clauses (SCCs) under Sentry's Data Processing Addendum (`[[TAHA: confirm Sentry DPA and ingest region]]`) |
| **PostHog** | Counts-and-enums product analytics | **European Union (Frankfurt, Germany)** by default (`[[TAHA: confirm PostHog EU vs US hosting]]`); PostHog, Inc. is headquartered in the **United States** | Hosted in the EU by default; EU-U.S. Data Privacy Framework and EU Standard Contractual Clauses (SCCs) under PostHog's DPA if transferred to the US (`[[TAHA: confirm PostHog EU project and DPA]]`) |
| **RevenueCat** | Subscription entitlement verification (internal account identifier and subscription status) | **United States** (RevenueCat, Inc.) | EU-U.S. Data Privacy Framework and EU Standard Contractual Clauses (SCCs) under RevenueCat's Data Processing Addendum (`[[TAHA: confirm RevenueCat DPA]]`) |
| **Expo** | Push notification relay to Apple APNs and Google FCM (neutral text only, no health details) | **United States** (650 Industries, Inc.) | EU Standard Contractual Clauses (SCCs) / Expo Terms & DPA (`[[TAHA: confirm Expo DPA / transfer terms]]`) |

You may request information about or a copy of the applicable transfer safeguards by contacting `[[TAHA: privacy email]]`.

---

## 5. Exporting Your Data and Deleting Your Account

- **Export your data (JSON):** At any time inside the app, open **Circle Settings > Export my data**. CareCircle generates a `.json` file containing your profile, subscription entitlements, memberships, circles, medications, dose events, appointments, tasks, visit notes, and care log entries and opens your device's share sheet so you can save or share it.
- **Delete your account:** At any time inside the app, open **Circle Settings > Delete account**. If you no longer have the app installed, see our account deletion page or email `[[TAHA: email]]`.

---

## 6. Your Privacy Rights and Contact

Depending on where you live (including under the GDPR / UK GDPR and applicable US state privacy laws), you have the right to access, export, correct, or delete your personal data, to restrict or object to certain processing, to withdraw your consent at any time, and to lodge a complaint with your local data protection supervisory authority (`[[TAHA: lead supervisory authority, if applicable]]`). You can exercise access/export and deletion directly in the app under **Circle Settings**, or by contacting us at `[[TAHA: privacy email]]`.
