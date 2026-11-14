import { z } from 'npm:zod@3.24.1';
import { fakeProvider, routes, type AiProvider, type AiTaskName } from './routes.ts';

export type AiErrorCode =
  | 'UNAUTHENTICATED'
  | 'QUOTA_EXCEEDED'
  | 'INPUT_INVALID'
  | 'SCHEMA_INVALID'
  | 'PROVIDER_ERROR';

export type AiCallLogRow = Record<'request_id' | 'user_id' | 'model' | 'prompt_version', string> &
  Record<'latency_ms' | 'input_tokens' | 'output_tokens', number> &
  Record<'validation_ok', boolean> &
  Record<'error_code', AiErrorCode | null> & { task: AiTaskName };

export type AiGatewayDeps = {
  providers?: { fake?: AiProvider };
  verifyJwt?: (token: string) => Promise<{ userId: string } | null>;
  logCall?: (row: AiCallLogRow) => Promise<void>;
  now?: () => number;
};

const requestEnvelopeSchema = z.object({
  task: z.enum(['carecircle.extractPrescription', 'carecircle.summarizeVisit']),
  input: z.record(z.unknown()),
  requestId: z.string().uuid(),
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fail = (code: AiErrorCode, message: string, retryable: boolean, status = 200): Response =>
  json({ ok: false, error: { code, message, retryable } }, status);

async function defaultVerifyJwt(token: string): Promise<{ userId: string } | null> {
  const url = Deno.env.get('SUPABASE_URL');
  const apikey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !apikey) return null;
  const headers = { authorization: `Bearer ${token}`, apikey };
  const res = await fetch(`${url}/auth/v1/user`, { headers });
  const data = res.ok ? ((await res.json()) as { id?: unknown }) : null;
  return typeof data?.id === 'string' ? { userId: data.id } : null;
}

async function defaultLogCall(row: AiCallLogRow): Promise<void> {
  const url = Deno.env.get('SUPABASE_URL');
  const apikey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !apikey) return;
  const headers = { authorization: `Bearer ${apikey}`, apikey, 'content-type': 'application/json' };
  await fetch(`${url}/rest/v1/ai_calls`, { method: 'POST', headers, body: JSON.stringify(row) });
}

export function createAiGatewayHandler(deps: AiGatewayDeps = {}) {
  const { verifyJwt = defaultVerifyJwt, logCall = defaultLogCall, now = Date.now } = deps;
  const fake = deps.providers?.fake ?? fakeProvider;

  return async (req: Request): Promise<Response> => {
    const match = /^Bearer\s+(.+)$/i.exec((req.headers.get('authorization') ?? '').trim());
    const authUser = match?.[1] ? await verifyJwt(match[1].trim()) : null;
    if (!authUser) return fail('UNAUTHENTICATED', 'Invalid or missing bearer token.', false, 401);

    const parsedReq = requestEnvelopeSchema.safeParse(await req.json().catch(() => null));
    if (!parsedReq.success) return fail('INPUT_INVALID', 'Invalid request envelope.', false, 400);

    const { task, input, requestId: request_id } = parsedReq.data;
    const route = routes[task];
    const { model, promptVersion: prompt_version, schema } = route;
    const startedAt = now();
    let [input_tokens, output_tokens] = [0, 0];
    const meta = { request_id, user_id: authUser.userId, task, model, prompt_version };
    const record = (validation_ok: boolean, error_code: AiErrorCode | null) => {
      const toks = { latency_ms: Math.max(0, now() - startedAt), input_tokens, output_tokens };
      return logCall({ ...meta, ...toks, validation_ok, error_code });
    };

    try {
      for (const attempt of [1, 2] as const) {
        const res = await fake.generate({ ...route, input, attempt });
        input_tokens += res.inputTokens;
        output_tokens += res.outputTokens;
        const validated = schema.safeParse(res.output);
        if (validated.success) {
          const latencyMs = Math.max(0, now() - startedAt);
          await record(true, null);
          return json({ ok: true, output: validated.data, model, latencyMs });
        }
      }
      await record(false, 'SCHEMA_INVALID');
      return fail('SCHEMA_INVALID', 'Model output failed validation twice.', false);
    } catch {
      await record(false, 'PROVIDER_ERROR');
      return fail('PROVIDER_ERROR', 'Provider call failed.', true);
    }
  };
}

if (import.meta.main) Deno.serve(createAiGatewayHandler());
