# CareCircle Terms of Use

**DRAFT, not legal advice, to be checked**

- **Effective date:** `[[TAHA: effective date]]`
- **Provider / Publisher:** `[[TAHA: legal entity or full name]]`, `[[TAHA: postal address]]`
- **Support & legal contact email:** `[[TAHA: support email]]`

---

## 1. Not Medical Advice

**CareCircle supports family care coordination and does not provide medical advice.** (Same meaning as `common.notMedicalAdvice` in `apps/carecircle/i18n/en.json`.)

- CareCircle is an organisational tool to help family members coordinate medication schedules, dose check-offs, appointments, tasks, and notes from doctor visits.
- CareCircle is **not** a medical device, clinical decision support system, healthcare provider, or emergency alert service.
- AI-assisted prescription label scans and doctor's visit summaries generate **unconfirmed drafts only**. They can make mistakes or miss details. You are responsible for reviewing every extracted field, follow-up task, and medication change against the original prescription label or your doctor's instructions before confirming and saving.
- Never disregard, delay, or change professional medical advice or prescribed treatment because of information shown in CareCircle. In a medical emergency, call your local emergency number immediately.

---

## 2. Accounts, Care Circles, and Family Consent

- You must be at least 18 years old (or the age of majority in your jurisdiction) to create a CareCircle account.
- When you create a care circle or enter information about a care recipient (such as a parent or relative) or upload a prescription label or visit recording, you confirm that you have the authority and any required consent from the care recipient (or their legal representative, and any other participant in a recorded visit where required by law) to share and coordinate that information within your family circle.
- Each account may own **1 care circle** (`CIRCLE_LIMIT_REACHED` in `supabase/carecircle/migrations/20261115000006_create_circle.sql` and `supabase/carecircle/migrations/20261120000001_review_s15_18.sql`).
- Circle roles:
  - **Owner:** Manages circle members, invites, and ownership transfer, and can add, edit, and record medications, doses, appointments, tasks, and visit notes.
  - **Helper:** Can add, edit, and record medications, doses, appointments, tasks, and visit notes.
  - **Viewer:** Has read-only access to the circle's schedule, calendar, tasks, and care log.

---

## 3. Free Plan and CareCircle Family Plan Subscriptions

### 3.1 Plan Features

- **Free Plan:** Includes 1 care circle with up to 2 members, medication schedules and dose check-offs, prescription label scanning, shared appointment calendar, shared tasks, and the in-app care log.
- **CareCircle Family Plan (`carecircle_family`):** Unlocks up to 8 members in the circle owner's care circle, AI visit-note summaries (from audio or typed notes), and care log PDF exports (up to 90 days per export). The Family plan attaches to the circle through the circle **owner's** active entitlement (`supabase/carecircle/functions/_shared/entitlements.ts`, `supabase/carecircle/migrations/20261120000001_review_s15_18.sql`).

### 3.2 Pricing, Billing, and Auto-Renewal

- **Price from the store:** Subscription prices, currency, billing period, and any eligible free trial or introductory offer are retrieved directly from the Apple App Store or Google Play Store and displayed on the in-app paywall sheet before you confirm your purchase (`apps/carecircle/src/features/paywall/api.ts`, `apps/carecircle/src/features/paywall/components/PaywallSheet.tsx`).
- **Payment and auto-renewal:** Payment is charged to your Apple ID or Google Play account at confirmation of purchase (or at the end of any applicable free trial period). Subscriptions **automatically renew** for the same billing period and price unless auto-renew is turned off at least 24 hours before the end of the current billing or trial period.
- **How to manage or cancel in the store:** You can manage or cancel your subscription at any time in your device's store subscription settings:
  - **iOS (Apple App Store):** Settings > `[your name]` > Subscriptions (or tap **Circle Settings > Manage store subscription** in CareCircle, which opens `https://apps.apple.com/account/subscriptions`).
  - **Android (Google Play Store):** Google Play > Profile icon > Payments & subscriptions > Subscriptions (or tap **Circle Settings > Manage store subscription** in CareCircle, which opens `https://play.google.com/store/account/subscriptions`).
- **Account deletion and store subscriptions:** Deleting your CareCircle account deletes your CareCircle data on our servers, but **does not automatically cancel** an active subscription billed by Apple or Google. Please cancel your subscription in the Apple App Store or Google Play Store before or after deleting your account if you do not wish to be billed on the next renewal date.
- **Refunds:** Because billing is processed by Apple or Google, refund requests are handled by Apple Support or Google Play Support under their respective store terms.

---

## 4. Acceptable Use

You agree not to:

- Use CareCircle for any unlawful purpose or upload information about any person without their permission or legal authority.
- Record a doctor's visit audio note without the consent of the participants where required by applicable law.
- Attempt to bypass Row-Level Security, plan limits, rate limits (60 AI requests per hour per user in `supabase/carecircle/functions/ai/handler.ts`), or authentication checks.
- Share single-use invite links publicly or attempt to access another family's circle without authorization.
- Reverse-engineer, disrupt, or overload CareCircle's servers or Edge Functions.

---

## 5. Account Deletion and Termination

You may delete your account at any time in the app under **Circle Settings > Delete account** (or by following the instructions in `docs/legal/delete-account.md`). If you are the owner of a circle that has other members, you must either transfer ownership to another member who does not already own a circle or remove the other members before deleting your account.

---

## 6. Disclaimers, Limitation of Liability, and Governing Law

- CareCircle is provided on an `"AS IS"` and `"AS AVAILABLE"` basis without warranties of any kind, to the maximum extent permitted by applicable law.
- Liability cap and consumer rights: `[[TAHA: jurisdiction-specific limitation of liability and mandatory consumer rights clause]]`
- Governing law and venue: `[[TAHA: governing law and court jurisdiction]]`
