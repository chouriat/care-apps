# Delete Your CareCircle Account

**DRAFT, not legal advice, to be checked**

This page explains how to permanently delete your CareCircle account and what happens to your data, both from inside the CareCircle app and by email if you no longer have the app installed (as required by Google Play and Apple App Store account-deletion guidelines).

---

## 1. Delete Your Account Inside the App (Immediate)

1. Open **CareCircle** and sign in.
2. Open **Circle Settings** (`apps/carecircle/app/circle.tsx`).
3. Scroll to **Account and data** and tap **Delete account**, then tap **Confirm delete account**.
   - *Tip:* If you want a copy of your data first, tap **Export my data (JSON)** right above **Delete account** to save or share your data as a `.json` file before deleting.
4. **If you own a circle that has other family members:**
   - CareCircle will ask you to either **transfer ownership** to another member in your circle (tap **Make Owner** next to a helper or viewer on the **Circle Settings** screen) or **remove** the other members first (`OWNER_MUST_TRANSFER` in `supabase/carecircle/migrations/20261120000001_review_s15_18.sql`).
   - Once you are either not an owner of a multi-member circle or you are the only member left in your circle, tap **Delete account** > **Confirm delete account** to complete deletion immediately.

---

## 2. Delete Your Account Without the App (By Email)

If you have already uninstalled CareCircle or cannot sign in on a phone:

1. Send an email to **`[[TAHA: email]]`** from the email address linked to your CareCircle account with the subject line **`Delete my CareCircle account`**.
2. If you own a circle shared with other family members, tell us in your email whether you would like us to remove your membership after you or another member takes over, or delete the circle if you are the sole member.
3. We will verify your request and delete your account within **`[[TAHA: response SLA, e.g. 7 days]]`** and confirm by reply email.

---

## 3. What Is Deleted and What Is Kept

When your account is deleted (`supabase/carecircle/migrations/20261120000001_review_s15_18.sql` and `supabase/carecircle/functions/delete-account/handler.ts`):

- **Deleted immediately:**
  - Your authentication account (`auth.users`) and profile (`public.users_profile`).
  - Your device push notification tokens (`public.push_tokens`), subscription entitlement rows (`public.entitlements`), and AI call metadata logs (`public.ai_calls`).
  - Your circle memberships (`public.circle_members`).
  - **If you are the sole member (and owner) of a circle:** your entire circle (`public.circles`), all of its medications, dose events, appointments, tasks, visit notes, invites, and care log entries, plus all files stored under that circle in `prescription-photos`, `visit-audio`, and `log-exports` Storage buckets.
- **Anonymised in surviving shared circles (if you were a member of another family member's circle):**
  - So the surviving family does not lose its care history (such as whether a dose was given or a task was completed), rows in that surviving circle remain, with your user ID cleared to `NULL` (`created_by`, `acted_by`, `driver_user_id`, `assignee`, `done_by`, `used_by`, `ref_id`).
- **Store subscriptions:**
  - Deleting your CareCircle account does **not** automatically cancel an active subscription billed by the Apple App Store or Google Play Store. To avoid future charges, cancel your subscription in your device's Apple App Store or Google Play Store subscription settings.
