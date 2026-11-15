import { z } from 'zod';

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'Date must be in YYYY-MM-DD format');

export const knownMedInputSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1),
    strength: z.string().trim().min(1).nullable(),
  })
  .strict();

export const summarizeVisitInputSchema = z
  .object({
    audioPath: z.string().trim().min(1).optional(),
    text: z.string().trim().min(1).optional(),
    knownMeds: z.array(knownMedInputSchema),
  })
  .strict()
  .refine((val) => Boolean(val.audioPath || val.text), 'Either audioPath or text must be provided');

export type SummarizeVisitInput = z.infer<typeof summarizeVisitInputSchema>;

export const followUpItemSchema = z
  .object({
    title: z.string().trim().min(1),
    dueHint: z.string().trim().min(1).nullable(),
    dueDate: isoDateSchema.nullable(),
  })
  .strict();

export const medChangeItemSchema = z.discriminatedUnion('action', [
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

export const summarizeVisitOutputSchema = z
  .object({
    summary: z.string().trim().min(1),
    followUps: z.array(followUpItemSchema),
    medChanges: z.array(medChangeItemSchema),
    questionsToAsk: z.array(z.string().trim().min(1)),
  })
  .strict();

export type SummarizeVisitOutput = z.infer<typeof summarizeVisitOutputSchema>;

export const visitSchema = summarizeVisitOutputSchema;

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };

export const summarizeVisitJsonSchema: Record<string, unknown> = {
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

export const FAKE_SUMMARIZE_VISIT_OUTPUT: SummarizeVisitOutput = {
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
};
