import { z } from 'zod';

export const AI_GATEWAY_PATH = '/functions/v1/ai';
export type AiTaskName = 'carecircle.extractPrescription' | 'carecircle.summarizeVisit';
export const aiErrorCodeSchema = z.enum([
  'UNAUTHENTICATED',
  'QUOTA_EXCEEDED',
  'INPUT_INVALID',
  'SCHEMA_INVALID',
  'PROVIDER_ERROR',
]);
export type AiErrorCode = z.infer<typeof aiErrorCodeSchema>;

const failureSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: aiErrorCodeSchema, message: z.string(), retryable: z.boolean() }),
});
const successEnvelopeSchema = z.object({
  ok: z.literal(true),
  output: z.unknown(),
  model: z.string().min(1),
  latencyMs: z.number().nonnegative(),
});

export type AiGatewayFailure = z.infer<typeof failureSchema>;
export type AiGatewaySuccess<O> = Omit<z.infer<typeof successEnvelopeSchema>, 'output'> & {
  output: O;
};
export type AiGatewayResponse<O> = AiGatewaySuccess<O> | AiGatewayFailure;
export type AiGatewayRequest<I = unknown> = Record<'requestId', string> &
  Record<'task', AiTaskName> & { input: I };
export type AiFetch = (
  url: string,
  init: Record<'method' | 'body', string> & { headers: Record<string, string> },
) => Promise<{ status: number; json(): Promise<unknown> }>;

const err = (code: AiErrorCode, message: string, retryable = false): AiGatewayFailure => ({
  ok: false,
  error: { code, message, retryable },
});

export function createAiGatewayClient(opts: {
  baseUrl: string;
  getAccessToken: () => Promise<string | null> | string | null;
  fetchImpl?: AiFetch;
}) {
  const fetchFn: AiFetch = opts.fetchImpl ?? fetch;
  const url = `${opts.baseUrl.replace(/\/$/, '')}${AI_GATEWAY_PATH}`;
  return {
    async call<O>(req: AiGatewayRequest, schema: z.ZodType<O>): Promise<AiGatewayResponse<O>> {
      const token = await opts.getAccessToken();
      if (!token) return err('UNAUTHENTICATED', 'No token.');
      try {
        const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
        const res = await fetchFn(url, { method: 'POST', headers, body: JSON.stringify(req) });
        // Supabase's own gateway answers a bad or expired JWT with 401 and its own body.
        if (res.status === 401) return err('UNAUTHENTICATED', 'Session expired.');
        const raw: unknown = await res.json().catch(() => null);
        const failed = failureSchema.safeParse(raw);
        if (failed.success) return failed.data;
        if (res.status >= 500) return err('PROVIDER_ERROR', 'Gateway error.', true);
        const env = successEnvelopeSchema.safeParse(raw);
        const out = env.success ? schema.safeParse(env.data.output) : null;
        return env.success && out?.success
          ? { ok: true, output: out.data, model: env.data.model, latencyMs: env.data.latencyMs }
          : err('SCHEMA_INVALID', 'Invalid output.');
      } catch {
        return err('PROVIDER_ERROR', 'Network error.', true);
      }
    },
  };
}
