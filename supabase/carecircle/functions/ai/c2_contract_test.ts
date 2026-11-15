// CC-0 [safety] (added in review): the gateway validates model output with its own copy of the
// C2 schemas, because Edge Functions cannot import packages/ai-gateway. This test runs the
// gateway's copy over the same case list as packages/ai-gateway/src/carecircle-schemas.test.ts,
// so the two copies cannot drift apart.
import cases from '../../../../packages/ai-gateway/src/carecircle-c2-cases.json' with { type: 'json' };
import { FAKE_FIXTURES, rxJsonSchema, rxSchema, visitJsonSchema, visitSchema } from './routes.ts';

type Case = { why: string; patch: Record<string, unknown> };
type Parser = { safeParse(value: unknown): { success: boolean } };

const fail = (msg: string): never => {
  throw new Error(msg);
};

function applyPatch(base: Record<string, unknown>, patch: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return out;
}

function checkCases(
  name: string,
  schema: Parser,
  group: { valid: Array<{ why: string; output: unknown }>; invalid: Case[] },
) {
  const base = group.valid[0].output as Record<string, unknown>;
  for (const { why, output } of group.valid) {
    if (!schema.safeParse(output).success) fail(`${name}: valid case refused: ${why}`);
  }
  for (const { why, patch } of group.invalid) {
    if (schema.safeParse(applyPatch(base, patch)).success)
      fail(`${name}: invalid case accepted: ${why}`);
  }
}

Deno.test('gateway extractPrescription schema matches contract C2 case by case', () => {
  checkCases('extractPrescription', rxSchema, cases.extractPrescription);
});

Deno.test('gateway summarizeVisit schema matches contract C2 case by case', () => {
  checkCases('summarizeVisit', visitSchema, cases.summarizeVisit);
});

Deno.test('the fake provider answers are complete C2 outputs', () => {
  if (!rxSchema.safeParse(FAKE_FIXTURES['carecircle.extractPrescription']).success) {
    fail('fake extractPrescription answer is not valid C2');
  }
  const visit = FAKE_FIXTURES['carecircle.summarizeVisit'] as {
    medChanges: Array<Record<string, unknown>>;
    followUps: Array<Record<string, unknown>>;
  };
  if (!visitSchema.safeParse(visit).success) fail('fake summarizeVisit answer is not valid C2');
  for (const change of visit.medChanges) {
    for (const key of ['action', 'medicationId', 'name', 'detail']) {
      if (!(key in change)) fail(`fake medChange is missing ${key}`);
    }
  }
  for (const followUp of visit.followUps) {
    for (const key of ['title', 'dueHint', 'dueDate']) {
      if (!(key in followUp)) fail(`fake followUp is missing ${key}`);
    }
  }
});

Deno.test('provider JSON schemas require every key the Zod schemas require', () => {
  const keys = (s: Record<string, unknown>) =>
    Object.keys((s.properties ?? {}) as Record<string, unknown>)
      .sort()
      .join(',');
  const req = (s: Record<string, unknown>) =>
    [...((s.required ?? []) as string[])].sort().join(',');
  const visitProps = visitJsonSchema.properties as Record<string, Record<string, unknown>>;
  const objects: Array<[string, Record<string, unknown>]> = [
    ['extractPrescription', rxJsonSchema],
    ['summarizeVisit', visitJsonSchema],
    ['followUps item', visitProps.followUps.items as Record<string, unknown>],
    ['medChanges item', visitProps.medChanges.items as Record<string, unknown>],
  ];
  for (const [name, schema] of objects) {
    if (schema.additionalProperties !== false) fail(`${name}: additionalProperties must be false`);
    if (keys(schema) !== req(schema))
      fail(`${name}: required (${req(schema)}) must list every property (${keys(schema)})`);
  }
});
