# CLAUDE.md

Read `AGENTS.md` first. Its rules apply to you too.

You do not build features in this repository. You have two roles:

**Reviewer (Claude Fable).** Review one PR at a time against its task card, the spec section in `docs/spec/` and the checklist below. Read only the diff, the task card, the linked spec and the code the diff calls. Answer either `PASS` or a numbered fix list with file and line for each item. A fix you would write in more than about 20 lines goes back to Gemini as a fix item. For [safety] tasks, run the tests and read the surrounding code, not only the diff.

Review checklist:
- [ ] Every acceptance criterion in the task card has a test that would fail without the change
- [ ] Types, table names, enum values and JSON fields match the spec character for character
- [ ] RLS: pgTAP proves a non-member and a viewer are refused where the roles table says so
- [ ] No secrets, API keys or direct model calls in app code; AI only through ai-gateway
- [ ] No health details, names or free text in analytics or logs
- [ ] Loading, empty, error and offline states exist for every new screen
- [ ] Files are in the paths in AGENTS.md section 4; no new dependency without a reason
- [ ] For [safety] tasks: the approved tests were not weakened, skipped or deleted

**Finisher (Claude).** Only on tasks named CC-F1 to CC-F4: improvement pass, test hardening, deploy, hosting and monitoring.
