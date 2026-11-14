import { z } from 'npm:zod@3.24.1';

export type AiTaskName = 'carecircle.extractPrescription' | 'carecircle.summarizeVisit';
export type AiProviderName = 'fake';

export const rxSchema = z.object({
  name: z.string().min(1),
  strength: z.string().nullable(),
  doseText: z.string().min(1),
  schedule: z.object({ kind: z.string().min(1) }).passthrough(),
  instructions: z.string().nullable(),
  fieldConfidence: z.record(z.number().min(0).max(1)),
  rawText: z.string(),
});

export const visitSchema = z.object({
  summary: z.string().min(1),
  followUps: z.array(z.object({ title: z.string().min(1) }).passthrough()),
  medChanges: z.array(z.object({ action: z.enum(['start', 'stop', 'change_dose']) }).passthrough()),
  questionsToAsk: z.array(z.string()),
});

const defineRoute = (task: AiTaskName, model: string, schema: z.ZodTypeAny) => ({
  task,
  provider: 'fake' as AiProviderName,
  model,
  promptFile: `packages/ai-gateway/prompts/${task.replace('.', '/')}.md`,
  promptVersion: 'v1',
  schema,
  timeoutMs: 25_000,
});

export type AiRouteConfig = ReturnType<typeof defineRoute>;
const rxTask = 'carecircle.extractPrescription' as const;
const visitTask = 'carecircle.summarizeVisit' as const;

export const routes: Record<AiTaskName, AiRouteConfig> = {
  [rxTask]: defineRoute(rxTask, 'fake/extract-prescription-v1', rxSchema),
  [visitTask]: defineRoute(visitTask, 'fake/summarize-visit-v1', visitSchema),
};

export type AiProviderRequest = AiRouteConfig &
  Record<'attempt', 1 | 2> & { input: Record<string, unknown> };
export type AiProviderResult = Record<'inputTokens' | 'outputTokens', number> & { output: unknown };
export type AiProvider = { generate: (req: AiProviderRequest) => Promise<AiProviderResult> };

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
    followUps: [{ title: 'Book blood test' }],
    medChanges: [{ action: 'stop', name: 'Aspirin' }],
    questionsToAsk: ['Should blood pressure be logged twice daily?'],
  },
};

export const fakeProvider: AiProvider = {
  generate: async (req) => ({ output: FAKE_FIXTURES[req.task], inputTokens: 64, outputTokens: 48 }),
};
