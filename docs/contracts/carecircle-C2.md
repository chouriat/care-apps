# Contract C2: CareCircle AI Gateway Tasks and Schemas

This document specifies **Contract C2** for CareCircle's two AI tasks (`carecircle.extractPrescription` and `carecircle.summarizeVisit`).

- **Package Schemas (App & Tests):**
  - [`packages/ai-gateway/schemas/carecircle/extractPrescription.ts`](../../packages/ai-gateway/schemas/carecircle/extractPrescription.ts)
  - [`packages/ai-gateway/schemas/carecircle/summarizeVisit.ts`](../../packages/ai-gateway/schemas/carecircle/summarizeVisit.ts)
- **Edge Function Schemas (Deno Runtime):**
  - [`supabase/carecircle/functions/ai/routes.ts`](../../supabase/carecircle/functions/ai/routes.ts)
- **Shared Contract Test Cases:**
  - [`packages/ai-gateway/src/carecircle-c2-cases.json`](../../packages/ai-gateway/src/carecircle-c2-cases.json)
  - [`packages/ai-gateway/src/carecircle-schemas.test.ts`](../../packages/ai-gateway/src/carecircle-schemas.test.ts)
  - [`supabase/carecircle/functions/ai/c2_contract_test.ts`](../../supabase/carecircle/functions/ai/c2_contract_test.ts)

---

## 1. `carecircle.extractPrescription`

### Input (`extractPrescriptionInputSchema`)

```json
{
  "imagePath": "<circle_id>/<uuid>.jpg"
}
```

- `imagePath`: non-empty trimmed string (`z.string().trim().min(1)`), strict object (no unknown keys). The AI gateway requires `imagePath` to match `<circle_id>/<uuid>.jpg` (lowercase UUIDs in the `prescription-photos` bucket) and refuses any other path shape with `INPUT_INVALID` before checking membership or reading Storage.

### Output (`extractPrescriptionOutputSchema` / `rxSchema`)

```json
{
  "name": "Metformin",
  "strength": "500 mg",
  "doseText": "1 tablet",
  "schedule": { "kind": "daily", "times": ["08:00", "20:00"] },
  "instructions": "Take with food",
  "fieldConfidence": { "name": 0.97, "strength": 0.92, "schedule": 0.71 },
  "rawText": "Metformin 500 mg take 1 tablet twice daily with food"
}
```

- `name`: non-empty trimmed string.
- `strength`: non-empty trimmed string or `null`.
- `doseText`: non-empty trimmed string.
- `schedule`: C1 discriminated union (`daily`, `weekly`, `every_n_days`, `as_needed`) with 24-hour `HH:MM` times and `mon..sun` weekdays.
- `instructions`: non-empty trimmed string or `null`.
- `fieldConfidence`: strict object allowing optional scores in `[0, 1]` for `name`, `strength`, `doseText`, `schedule`, and `instructions`.
- `rawText`: string.

---

## 2. `carecircle.summarizeVisit`

### Input (`summarizeVisitInputSchema`)

```json
{
  "audioPath": "circles/<circle_id>/visits/<filename>.m4a",
  "text": "Doctor said blood pressure is stable...",
  "knownMeds": [
    {
      "id": "c1200001-0000-4000-8000-000000000001",
      "name": "Aspirin",
      "strength": "81 mg"
    }
  ]
}
```

- At least one of `audioPath` or `text` must be provided (non-empty trimmed string).
- `knownMeds`: required array of `{ id: uuid, name: non-empty string, strength: non-empty string | null }`.

### Output (`summarizeVisitOutputSchema` / `visitSchema`)

```json
{
  "summary": "Blood pressure is stable. Book a blood test in two weeks. Stop aspirin until the next visit.",
  "followUps": [
    { "title": "Book blood test", "dueHint": "in 2 weeks", "dueDate": "2026-11-23" }
  ],
  "medChanges": [
    {
      "action": "stop",
      "medicationId": "c1200001-0000-4000-8000-000000000001",
      "name": "Aspirin",
      "detail": "Stop until next visit"
    },
    {
      "action": "start",
      "medicationId": null,
      "name": "Vitamin D3",
      "detail": "1000 IU once daily"
    }
  ],
  "questionsToAsk": ["Should we bring the blood pressure log?"]
}
```

- `summary`: non-empty trimmed string.
- `followUps`: array of `{ title: non-empty string, dueHint: non-empty string | null, dueDate: YYYY-MM-DD | null }`.
- `medChanges`: discriminated union on `action`:
  - `action: 'start'` requires `medicationId: null`.
  - `action: 'stop'` and `action: 'change_dose'` require `medicationId` to be a valid UUID string.
  - `name`: non-empty trimmed string; `detail`: non-empty trimmed string or `null`.
- `questionsToAsk`: array of non-empty trimmed strings.
