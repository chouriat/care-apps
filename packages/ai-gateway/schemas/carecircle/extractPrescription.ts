import { z } from 'zod';

const time24hSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be in 24-hour HH:MM format');

const weekdaySchema = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

export const scheduleSchema = z.discriminatedUnion('kind', [
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

export const fieldConfidenceSchema = z
  .object({
    name: confidenceScoreSchema.optional(),
    strength: confidenceScoreSchema.optional(),
    doseText: confidenceScoreSchema.optional(),
    schedule: confidenceScoreSchema.optional(),
    instructions: confidenceScoreSchema.optional(),
  })
  .strict();

export const extractPrescriptionInputSchema = z
  .object({
    imagePath: z.string().trim().min(1),
  })
  .strict();

export type ExtractPrescriptionInput = z.infer<typeof extractPrescriptionInputSchema>;

export const extractPrescriptionOutputSchema = z
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

export type ExtractPrescriptionOutput = z.infer<typeof extractPrescriptionOutputSchema>;

export const rxSchema = extractPrescriptionOutputSchema;

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };

export const extractPrescriptionJsonSchema: Record<string, unknown> = {
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

export const FAKE_EXTRACT_PRESCRIPTION_OUTPUT: ExtractPrescriptionOutput = {
  name: 'Metformin',
  strength: '500 mg',
  doseText: '1 tablet',
  schedule: { kind: 'daily', times: ['08:00', '20:00'] },
  instructions: 'Take with food',
  fieldConfidence: {
    name: 0.97,
    strength: 0.94,
    doseText: 0.95,
    schedule: 0.91,
    instructions: 0.89,
  },
  rawText: 'Metformin 500 mg - Take 1 tablet twice daily with food',
};
