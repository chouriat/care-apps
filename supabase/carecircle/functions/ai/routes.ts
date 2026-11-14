import { z } from 'npm:zod@3.24.1';

export type AiTaskName = 'carecircle.extractPrescription' | 'carecircle.summarizeVisit';
export type AiProviderName = 'fake' | 'anthropic' | 'gemini';

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

export type AiRouteConfig = {
  task: AiTaskName;
  provider: AiProviderName;
  model: string;
  promptFile: string;
  promptVersion: string;
  schema: z.ZodTypeAny;
  timeoutMs: number;
  inputMicrocentsPer1k: number;
  outputMicrocentsPer1k: number;
  costCurrency: string;
};

const rxTask = 'carecircle.extractPrescription' as const;
const visitTask = 'carecircle.summarizeVisit' as const;

export const routes: Record<AiTaskName, AiRouteConfig> = {
  [rxTask]: {
    task: rxTask,
    provider: 'gemini',
    model: 'gemini/gemini-2.5-flash',
    promptFile: 'packages/ai-gateway/prompts/carecircle/extractPrescription.md',
    promptVersion: 'v1',
    schema: rxSchema,
    timeoutMs: 25_000,
    inputMicrocentsPer1k: 15_000,
    outputMicrocentsPer1k: 60_000,
    costCurrency: 'USD',
  },
  [visitTask]: {
    task: visitTask,
    provider: 'anthropic',
    model: 'anthropic/claude-sonnet-4-20250514',
    promptFile: 'packages/ai-gateway/prompts/carecircle/summarizeVisit.md',
    promptVersion: 'v1',
    schema: visitSchema,
    timeoutMs: 25_000,
    inputMicrocentsPer1k: 300_000,
    outputMicrocentsPer1k: 1_500_000,
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
    followUps: [{ title: 'Book blood test' }],
    medChanges: [{ action: 'stop', name: 'Aspirin' }],
    questionsToAsk: ['Should blood pressure be logged twice daily?'],
  },
};

export const fakeProvider: AiProvider = {
  generate: async (req) => ({ output: FAKE_FIXTURES[req.task], inputTokens: 64, outputTokens: 48 }),
};
