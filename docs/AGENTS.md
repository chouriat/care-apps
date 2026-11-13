# AGENTS.md

Rules for every AI agent working in this repository. Gemini builds features. Claude Fable reviews every pull request. Claude does the final steps (improve, test hardening, deploy, hosting). Taha owns the repo and merges.

The product spec lives in `docs/spec/`. If this file, the spec and the code disagree, the spec wins. To change the spec, open a PR that changes only the spec, and wait for Taha to merge it.

MUST, SHOULD and MAY are used in the RFC 2119 sense.

## 1. Before you start a task

1. Read this file.
2. Read the task card you were given. It names the task ID, the spec section and the files you may touch.
3. Read that spec section in `docs/spec/` and the contract files in `docs/contracts/` it depends on.
4. Do not assume anything that is not written in these files. If something is unclear, stop and ask in the PR under "Questions". Do not guess.

## 2. Workflow for every task

1. Create a branch named `task/<id>-<slug>`, for example `task/cc-2a-dose-generator`.
2. Write the tests first: one test per acceptance criterion in the task card.
3. Write the code until the tests pass.
4. Keep the PR under 400 changed lines, not counting lockfiles, snapshots and generated types. If it will be bigger, stop and say so in the PR.
5. Run locally: `pnpm typecheck && pnpm lint && pnpm test`. Run the Maestro flows your change touches.
6. Open the PR with the template in section 8. CI must be green before review.
7. Claude Fable reviews. Fix everything in its numbered list and push. After 2 failed review rounds, stop: Taha decides what happens next.
8. Never merge your own PR.

### Safety-critical tasks: tests first, in a separate PR

For tasks marked **[safety]** in the task card, open a first PR that contains only the test files. Wait until Fable approves it. Then open the code PR. Never weaken, skip or delete an approved test.

Safety-critical areas: contracts and RLS policies, auth, payments and entitlements, the ai-gateway API keys, the dose engine, account deletion.

## 3. Stack

Use exactly these. Do not add another dependency without naming it, its version and the reason in the PR.

| Concern | Choice |
| --- | --- |
| Monorepo | pnpm workspaces + Turborepo |
| App | Expo (SDK pinned in `docs/stack.md`), New Architecture on, TypeScript strict, Expo Router |
| Server state | TanStack Query v5 over the Supabase JS v2 client |
| Local state | Zustand |
| Validation | Zod. Schemas in `packages/ai-gateway/schemas/` and `packages/core/schemas/` are the source of truth; TypeScript types are inferred with `z.infer` |
| Forms | react-hook-form + `@hookform/resolvers/zod` |
| Backend | Supabase: Postgres, Auth, Storage, Edge Functions (Deno), `pg_cron` |
| Payments | RevenueCat (`react-native-purchases`) |
| Tests | Jest + React Native Testing Library; pgTAP for database and RLS; `deno test` for Edge Functions; Maestro for user flows |
| Quality | ESLint + Prettier, Sentry, PostHog |
| Builds | EAS Build profiles `development` and `preview` (production is Claude's job) |

## 4. File structure

Put files exactly here. App routes match the Screens table in the spec one to one.

```
AGENTS.md  GEMINI.md  CLAUDE.md
docs/spec/                 product spec (read only unless doing a spec PR)
docs/contracts/            carecircle-C1.md (data), carecircle-C2.md (AI)
docs/stack.md              pinned versions
apps/carecircle/
  app/                     Expo Router routes, e.g. (tabs)/today.tsx, meds/scan.tsx
  src/features/<feature>/
    components/            UI pieces, no data fetching
    hooks.ts               TanStack Query hooks
    api.ts                 Supabase calls for this feature only
    logic.ts               pure functions, tested without React
    *.test.ts(x)
  i18n/en.json             every user-facing string
  maestro/<flow>.yaml
packages/ui/               design tokens and shared components
packages/core/             auth, case conversion, notifications, paywall, analytics, shared schemas
packages/ai-gateway/       client.ts, schemas/<app>/<task>.ts, prompts/<app>/<task>.md
supabase/carecircle/
  migrations/              SQL, one file per change, timestamp-prefixed
  functions/<name>/index.ts
  tests/                   pgTAP
evals/carecircle/labels/   20 prescription label images + expected.json
```

## 5. Coding rules

1. Contracts first. A feature task MUST NOT start until the contract files it uses are merged.
2. Database tables and columns are `snake_case`. TypeScript types are `PascalCase`. JSON sent over the network is `camelCase`. Convert only in `packages/core/case.ts`.
3. IDs are UUID v4 strings. Timestamps are ISO 8601 UTC strings over the network and `timestamptz` in Postgres. Money is integer minor units (cents) plus an ISO 4217 currency code. Never floats for money.
4. Every enum value in the spec is the complete list. Adding a value is a spec change.
5. The app never calls an AI model directly. Every AI call goes through `POST /functions/v1/ai` and the response is validated with its Zod schema. Invalid output is retried once, then returned as `SCHEMA_INVALID`.
6. AI output is always a draft. The user confirms before anything is saved. Use the `ConfirmDraft` component.
7. No API keys, secrets or service-role keys in app code or in git. Secrets live in Supabase and EAS secrets only.
8. Every user-facing string lives in `i18n/en.json`. No hard-coded copy in components.
9. No `any`, no `@ts-ignore`, no `eslint-disable`, no `.skip` or `.only` in tests.
10. Every screen has loading, empty, error and offline states, using `EmptyState` and `ErrorState` from `packages/ui`.
11. Analytics event names are exactly those in the spec. Never send health details, medication names, names of people or free text as analytics properties.
12. Never log raw images, audio, transcripts or medical details. Log IDs and error codes only.
13. Accessibility: touch targets at least 44 pt, every icon button has an accessibility label, dynamic type supported, WCAG AA contrast.

## 6. Database rules

1. Every table that has `circle_id` has row-level security turned on.
2. A user can read rows only for circles they belong to (`circle_members`). Writes follow the roles table in the spec.
3. Every migration that adds or changes a table adds pgTAP tests proving: a non-member reads 0 rows, and a viewer cannot insert, update or delete.
4. Never edit a merged migration. Add a new one.

## 7. Definition of done

- [ ] The code matches the contract types; CI is green
- [ ] Every acceptance criterion in the task card has a test that would fail without the change
- [ ] Analytics events fire with the exact names in the spec
- [ ] Files are in the paths in section 4
- [ ] Claude Fable answered PASS

## 8. PR description template

```
Task: CC-2a   Spec: docs/spec/carecircle.md > Dose engine
What changed: 3 to 5 lines
Acceptance criteria:
  [x] <criterion copied from the task card>   evidence: <test name | screenshot | log>
Deviations from spec: none | each one with the reason
New dependencies: none | name, version, reason
Questions: none | list
```
