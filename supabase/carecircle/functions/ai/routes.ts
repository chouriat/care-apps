import { z } from 'npm:zod@3.24.1';
import { PROMPTS } from './prompts.ts';

export type AiTaskName = 'carecircle.extractPrescription' | 'carecircle.summarizeVisit';
export type AiProviderName = 'fake' | 'anthropic' | 'gemini';

const time24hSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be in 24-hour HH:MM format');

const weekdaySchema = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

const scheduleSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('daily'),
      times: z.array(time24hSchema).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('weekly'),
      days: z.array(weekdaySchema).min(1),
      times: z.array(time24hSchema).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('every_n_days'),
      n: z.number().int().positive(),
      times: z.array(time24hSchema).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('as_needed'),
    })
    .strict(),
]);

const confidenceScoreSchema = z.number().min(0).max(1);

const fieldConfidenceSchema = z
  .object({
    name: confidenceScoreSchema.optional(),
    strength: confidenceScoreSchema.optional(),
    doseText: confidenceScoreSchema.optional(),
    schedule: confidenceScoreSchema.optional(),
    instructions: confidenceScoreSchema.optional(),
  })
  .strict();

export const rxSchema = z
  .object({
    name: z.string().trim().min(1),
    strength: z.string().trim().min(1).nullable(),
    doseText: z.string().trim().min(1),
    schedule: scheduleSchema,
    instructions: z.string().trim().min(1).nullable(),
    fieldConfidence: fieldConfidenceSchema,
    rawText: z.string(),
  })
  .strict();

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'Date must be in YYYY-MM-DD format');

const followUpItemSchema = z
  .object({
    title: z.string().trim().min(1),
    dueHint: z.string().trim().min(1).nullable(),
    dueDate: isoDateSchema.nullable(),
  })
  .strict();

const medChangeItemSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('start'),
      medicationId: z.null(),
      name: z.string().trim().min(1),
      detail: z.string().trim().min(1).nullable(),
    })
    .strict(),
  z
    .object({
      action: z.literal('stop'),
      medicationId: z.string().uuid(),
      name: z.string().trim().min(1),
      detail: z.string().trim().min(1).nullable(),
    })
    .strict(),
  z
    .object({
      action: z.literal('change_dose'),
      medicationId: z.string().uuid(),
      name: z.string().trim().min(1),
      detail: z.string().trim().min(1).nullable(),
    })
    .strict(),
]);

export const visitSchema = z
  .object({
    summary: z.string().trim().min(1),
    followUps: z.array(followUpItemSchema),
    medChanges: z.array(medChangeItemSchema),
    questionsToAsk: z.array(z.string().trim().min(1)),
  })
  .strict();

// Sent to the providers' JSON modes. Keep to keywords both accept: Anthropic's
// structured outputs reject minLength/minimum and similar over raw HTTP (only its
// SDKs strip them), so the Zod schemas above stay the final check for those.
const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };

export const rxJsonSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'name',
    'strength',
    'doseText',
    'schedule',
    'instructions',
    'fieldConfidence',
    'rawText',
  ],
  properties: {
    name: { type: 'string' },
    strength: nullableString,
    doseText: { type: 'string' },
    schedule: {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: { type: 'string', enum: ['daily', 'weekly', 'every_n_days', 'as_needed'] },
        times: { type: 'array', items: { type: 'string' } },
        days: { type: 'array', items: { type: 'string' } },
        n: { type: 'integer' },
      },
    },
    instructions: nullableString,
    fieldConfidence: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'number' },
        strength: { type: 'number' },
        doseText: { type: 'number' },
        schedule: { type: 'number' },
        instructions: { type: 'number' },
      },
    },
    rawText: { type: 'string' },
  },
};

export const visitJsonSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'followUps', 'medChanges', 'questionsToAsk'],
  properties: {
    summary: { type: 'string' },
    followUps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'dueHint', 'dueDate'],
        properties: {
          title: { type: 'string' },
          dueHint: nullableString,
          dueDate: nullableString,
        },
      },
    },
    medChanges: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'medicationId', 'name', 'detail'],
        properties: {
          action: { type: 'string', enum: ['start', 'stop', 'change_dose'] },
          medicationId: nullableString,
          name: { type: 'string' },
          detail: nullableString,
        },
      },
    },
    questionsToAsk: {
      type: 'array',
      items: { type: 'string' },
    },
  },
};

export type AiRouteConfig = {
  task: AiTaskName;
  provider: AiProviderName;
  model: string;
  promptFile: string;
  promptVersion: string;
  schema: z.ZodTypeAny;
  jsonSchema: Record<string, unknown>;
  timeoutMs: number;
  inputMicrocentsPer1k: number;
  outputMicrocentsPer1k: number;
  costCurrency: string;
};

const rxTask = 'carecircle.extractPrescription' as const;
const visitTask = 'carecircle.summarizeVisit' as const;

// Prices are list prices per 1M tokens, converted to microcents per 1k tokens
// ($1 per 1M tokens = 100_000 microcents per 1k). Checked 2026-11-14:
// - gemini-3.5-flash-lite: $0.30 in / $2.50 out (thinking billed as output),
//   https://ai.google.dev/gemini-api/docs/pricing
// - claude-sonnet-5-5: $2 in / $10 out, https://platform.claude.com/docs/en/about-claude/pricing
// Re-check when a model changes. gemini-2.5-flash is closed to new API users and
// claude-sonnet-4-20250514 was retired on 2026-06-15, so neither is used.
export const routes: Record<AiTaskName, AiRouteConfig> = {
  [rxTask]: {
    task: rxTask,
    provider: 'gemini',
    model: 'gemini/gemini-3.5-flash-lite',
    promptFile: PROMPTS[rxTask].promptFile,
    promptVersion: PROMPTS[rxTask].version,
    schema: rxSchema,
    jsonSchema: rxJsonSchema,
    timeoutMs: 25_000,
    inputMicrocentsPer1k: 30_000,
    outputMicrocentsPer1k: 250_000,
    costCurrency: 'USD',
  },
  [visitTask]: {
    task: visitTask,
    provider: 'anthropic',
    model: 'anthropic/claude-sonnet-5-5',
    promptFile: PROMPTS[visitTask].promptFile,
    promptVersion: PROMPTS[visitTask].version,
    schema: visitSchema,
    jsonSchema: visitJsonSchema,
    timeoutMs: 25_000,
    inputMicrocentsPer1k: 200_000,
    outputMicrocentsPer1k: 1_000_000,
    costCurrency: 'USD',
  },
};

export function estimateCostMicrocents(
  route: Pick<AiRouteConfig, 'inputMicrocentsPer1k' | 'outputMicrocentsPer1k'>,
  inputTokens: number,
  outputTokens: number,
): number {
  const totalThousandths =
    inputTokens * route.inputMicrocentsPer1k + outputTokens * route.outputMicrocentsPer1k;
  return Math.floor((totalThousandths + 500) / 1_000);
}

export type AiProviderRequest = AiRouteConfig & {
  attempt: 1 | 2;
  input: Record<string, unknown>;
  image?: {
    bytes: Uint8Array;
    mimeType: 'image/jpeg';
  };
  signal?: AbortSignal;
};

export type AiProviderResult = {
  output: unknown;
  inputTokens: number;
  outputTokens: number;
};

export type AiProvider = {
  generate: (req: AiProviderRequest) => Promise<AiProviderResult>;
};

export const FAKE_FIXTURES: Record<AiTaskName, unknown> = {
  [rxTask]: {
    name: 'Metformin',
    strength: '500 mg',
    doseText: '1 tablet',
    schedule: { kind: 'daily', times: ['08:00', '20:00'] },
    instructions: 'Take with food',
    fieldConfidence: { name: 0.97 },
    rawText: 'Metformin 500 mg - Take 1 tablet twice daily with food',
  },
  [visitTask]: {
    summary: 'Blood pressure is stable. Book a blood test in two weeks and stop Aspirin.',
    followUps: [{ title: 'Book blood test', dueHint: 'in 2 weeks', dueDate: '2026-11-23' }],
    medChanges: [
      {
        action: 'stop',
        medicationId: 'c1200001-0000-4000-8000-000000000001',
        name: 'Aspirin',
        detail: 'Stop until next visit',
      },
    ],
    questionsToAsk: ['Should blood pressure be logged twice daily?'],
  },
};

export const fakeProvider: AiProvider = {
  generate: async (req) => ({ output: FAKE_FIXTURES[req.task], inputTokens: 64, outputTokens: 48 }),
};
