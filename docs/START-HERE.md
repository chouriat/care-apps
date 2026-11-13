# Start Gemini on CareCircle

## 1. Set up the repo (Taha, about 10 minutes)

1. Create an empty GitHub repo, for example `care-apps`.
2. Copy these files into it, keeping the paths:
   - `AGENTS.md`, `GEMINI.md`, `CLAUDE.md` at the root
   - `docs/spec/carecircle.md`
   - `docs/tasks/carecircle.md`
3. Commit and push to `main`.
4. Have ready: a Supabase account, a RevenueCat account, and Claude and Gemini API keys (for task F-2b; you add them as Supabase secrets, never in the repo).

## 2. Open two Gemini sessions on the repo

- **G1** does data, backend and AI logic.
- **G2** does screens and UI.

## 3. Paste this as the first message in each session

```
You are the builder for this repository. Read AGENTS.md and GEMINI.md now and follow them exactly.
Your session is G1 (backend, data and AI logic). [For the second session: G2 (screens and UI).]
The task cards are in docs/tasks/carecircle.md. Do one card at a time, in the order of the table at the top, and only cards for your session.
Start with the first card for your session. Before writing code, list the files you will create or change and the tests you will write, then wait for my OK.
```

G2 waits until F-0 is merged, then starts with F-3a.

## 4. For each task

1. Gemini opens a PR using the template.
2. Paste the PR link into Claude Fable with: "Review this PR as described in CLAUDE.md."
3. If Fable says PASS and CI is green, merge (for contracts, auth, payments and delete-account, you merge after reading the summary).
4. If Fable returns a fix list, paste it to Gemini. After 2 failed rounds, stop and ask Claude to fix it.
5. Then give Gemini the next card.
