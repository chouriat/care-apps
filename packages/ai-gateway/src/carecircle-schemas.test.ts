import type { z } from 'zod';

interface ExtractPrescriptionModule {
  extractPrescriptionInputSchema: z.ZodType<{ imagePath: string }>;
  extractPrescriptionOutputSchema: z.ZodType<unknown>;
  rxSchema: z.ZodType<unknown>;
  extractPrescriptionJsonSchema: Record<string, unknown>;
  FAKE_EXTRACT_PRESCRIPTION_OUTPUT: Record<string, unknown>;
}

interface SummarizeVisitModule {
  summarizeVisitInputSchema: z.ZodType<unknown>;
  summarizeVisitOutputSchema: z.ZodType<unknown>;
  visitSchema: z.ZodType<unknown>;
  summarizeVisitJsonSchema: Record<string, unknown>;
  FAKE_SUMMARIZE_VISIT_OUTPUT: Record<string, unknown>;
}

function loadExtractPrescription(): ExtractPrescriptionModule {
  return jest.requireActual<ExtractPrescriptionModule>('../schemas/carecircle/extractPrescription');
}

function loadSummarizeVisit(): SummarizeVisitModule {
  return jest.requireActual<SummarizeVisitModule>('../schemas/carecircle/summarizeVisit');
}

describe('CC-0 C2 AI schemas (@carecircle/ai-gateway)', () => {
  it('validates carecircle.extractPrescription input, output, schedule, confidence range, and fake fixture', () => {
    const {
      extractPrescriptionInputSchema,
      extractPrescriptionOutputSchema,
      FAKE_EXTRACT_PRESCRIPTION_OUTPUT,
    } = loadExtractPrescription();

    expect(
      extractPrescriptionInputSchema.safeParse({ imagePath: 'circles/123/rx.jpg' }).success,
    ).toBe(true);
    expect(extractPrescriptionInputSchema.safeParse({ imagePath: '' }).success).toBe(false);
    expect(extractPrescriptionInputSchema.safeParse({}).success).toBe(false);
    expect(
      extractPrescriptionInputSchema.safeParse({ imagePath: 'rx.jpg', extra: true }).success,
    ).toBe(false);

    expect(
      extractPrescriptionOutputSchema.safeParse(FAKE_EXTRACT_PRESCRIPTION_OUTPUT).success,
    ).toBe(true);

    const specOutput = {
      name: 'Metformin',
      strength: '500 mg',
      doseText: '1 tablet',
      schedule: { kind: 'daily', times: ['08:00', '20:00'] },
      instructions: 'Take with food',
      fieldConfidence: { name: 0.97, strength: 0.92, schedule: 0.71 },
      rawText: 'Metformin 500 mg - Take 1 tablet twice daily with food',
    };
    expect(extractPrescriptionOutputSchema.safeParse(specOutput).success).toBe(true);

    // Rejects unknown schedule kind inside extractPrescription
    expect(
      extractPrescriptionOutputSchema.safeParse({
        ...specOutput,
        schedule: { kind: 'monthly', times: ['08:00'] },
      }).success,
    ).toBe(false);

    // Rejects confidence outside [0, 1]
    expect(
      extractPrescriptionOutputSchema.safeParse({
        ...specOutput,
        fieldConfidence: { name: 1.2 },
      }).success,
    ).toBe(false);
    expect(
      extractPrescriptionOutputSchema.safeParse({
        ...specOutput,
        fieldConfidence: { name: -0.1 },
      }).success,
    ).toBe(false);

    // Rejects empty name or doseText
    expect(extractPrescriptionOutputSchema.safeParse({ ...specOutput, name: '' }).success).toBe(
      false,
    );
    expect(extractPrescriptionOutputSchema.safeParse({ ...specOutput, doseText: '' }).success).toBe(
      false,
    );
  });

  it('validates carecircle.summarizeVisit input (requiring audioPath or text) and output (start medChanges require medicationId: null)', () => {
    const { summarizeVisitInputSchema, summarizeVisitOutputSchema, FAKE_SUMMARIZE_VISIT_OUTPUT } =
      loadSummarizeVisit();

    const knownMeds = [
      {
        id: 'c1200001-0000-4000-8000-000000000001',
        name: 'Aspirin',
        strength: '81 mg',
      },
    ];

    expect(
      summarizeVisitInputSchema.safeParse({
        text: 'Patient blood pressure is stable.',
        knownMeds,
      }).success,
    ).toBe(true);
    expect(
      summarizeVisitInputSchema.safeParse({
        audioPath: 'circles/123/visit.m4a',
        knownMeds,
      }).success,
    ).toBe(true);
    // Rejects when neither audioPath nor text is provided
    expect(
      summarizeVisitInputSchema.safeParse({
        knownMeds,
      }).success,
    ).toBe(false);

    expect(summarizeVisitOutputSchema.safeParse(FAKE_SUMMARIZE_VISIT_OUTPUT).success).toBe(true);

    const specOutput = {
      summary:
        'Blood pressure is well controlled. Book a blood test in two weeks and stop Aspirin.',
      followUps: [{ title: 'Book blood test', dueHint: 'in 2 weeks', dueDate: '2026-11-23' }],
      medChanges: [
        {
          action: 'stop',
          medicationId: 'c1200001-0000-4000-8000-000000000001',
          name: 'Aspirin',
          detail: 'Stop until next visit',
        },
        {
          action: 'start',
          medicationId: null,
          name: 'Vitamin D3',
          detail: '1000 IU once daily',
        },
      ],
      questionsToAsk: ['Should we bring the home blood pressure log to the next visit?'],
    };
    expect(summarizeVisitOutputSchema.safeParse(specOutput).success).toBe(true);

    // A start medChange MUST have medicationId: null
    expect(
      summarizeVisitOutputSchema.safeParse({
        ...specOutput,
        medChanges: [
          {
            action: 'start',
            medicationId: 'c1200001-0000-4000-8000-000000000001',
            name: 'Vitamin D3',
            detail: '1000 IU once daily',
          },
        ],
      }).success,
    ).toBe(false);

    // Rejects unknown medChange action
    expect(
      summarizeVisitOutputSchema.safeParse({
        ...specOutput,
        medChanges: [
          {
            action: 'pause',
            medicationId: null,
            name: 'Aspirin',
            detail: null,
          },
        ],
      }).success,
    ).toBe(false);

    // Rejects empty summary
    expect(
      summarizeVisitOutputSchema.safeParse({
        ...specOutput,
        summary: '',
      }).success,
    ).toBe(false);
  });
});
