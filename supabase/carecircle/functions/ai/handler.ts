import { z } from 'npm:zod@3.24.1';
import { PROMPTS } from './prompts.ts';
import {
  estimateCostMicrocents,
  fakeProvider,
  routes,
  type AiProvider,
  type AiProviderName,
  type AiRouteConfig,
  type AiTaskName,
} from './routes.ts';

export type AiErrorCode =
  | 'UNAUTHENTICATED'
  | 'QUOTA_EXCEEDED'
  | 'INPUT_INVALID'
  | 'SCHEMA_INVALID'
  | 'PROVIDER_ERROR';

export type AiCallLogRow = {
  request_id: string;
  user_id: string;
  task: AiTaskName;
  model: string;
  prompt_version: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_microcents: number;
  cost_currency: string;
  validation_ok: boolean;
  error_code: AiErrorCode | null;
};

export type AiGatewayDeps = {
  providers?: Partial<Record<AiProviderName, AiProvider>>;
  verifyJwt?: (token: string) => Promise<{ userId: string } | null>;
  logCall?: (row: AiCallLogRow) => Promise<void>;
  countRecentCalls?: (userId: string, sinceIso: string) => Promise<number>;
  routeOverrides?: Partial<Record<AiTaskName, Partial<AiRouteConfig>>>;
  fetchImpl?: typeof fetch;
  getEnv?: (key: string) => string | undefined;
  now?: () => number;
};

const HOURLY_CALL_LIMIT = 60;
const ONE_HOUR_MS = 3_600_000;

const requestEnvelopeSchema = z.object({
  task: z.enum(['carecircle.extractPrescription', 'carecircle.summarizeVisit']),
  input: z.record(z.unknown()),
  requestId: z.string().uuid(),
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fail = (code: AiErrorCode, message: string, retryable: boolean, status = 200): Response =>
  json({ ok: false, error: { code, message, retryable } }, status);

const stripModelPrefix = (model: string): string => {
  const slashIndex = model.indexOf('/');
  return slashIndex >= 0 ? model.slice(slashIndex + 1) : model;
};

function formatUserDataMessage(input: Record<string, unknown>): string {
  return `<user_input_data>\n${JSON.stringify(input)}\n</user_input_data>`;
}

class ProviderHttpError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(provider: AiProviderName, status: number) {
    super(`${provider} HTTP ${status}`);
    this.status = status;
    this.retryable = status === 429 || status >= 500;
  }
}

function parseJsonText(rawText: string): unknown {
  const trimmed = rawText.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  try {
    return JSON.parse(fenced?.[1] ?? trimmed);
  } catch {
    return null;
  }
}

function createAnthropicProvider(
  fetchImpl: typeof fetch,
  getEnv: (key: string) => string | undefined,
): AiProvider {
  return {
    generate: async (req) => {
      const apiKey = getEnv('ANTHROPIC_API_KEY');
      if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');
      const compiledPrompt = PROMPTS[req.task];
      const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: stripModelPrefix(req.model),
          // Room for adaptive thinking plus the JSON answer; thinking tokens count here.
          max_tokens: 4096,
          system: compiledPrompt.systemPrompt,
          messages: [
            {
              role: 'user',
              content: formatUserDataMessage(req.input),
            },
          ],
          output_config: {
            format: {
              type: 'json_schema',
              schema: req.jsonSchema,
            },
          },
        }),
        signal: req.signal,
      });
      if (!res.ok) {
        console.warn('ai_provider_http_error', { status: res.status });
        throw new ProviderHttpError('anthropic', res.status);
      }
      const data = (await res.json()) as {
        content?: Array<{ type?: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const text = data.content?.find((block) => block.type === 'text')?.text ?? '';
      return {
        output: parseJsonText(text),
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      };
    },
  };
}

function createGeminiProvider(
  fetchImpl: typeof fetch,
  getEnv: (key: string) => string | undefined,
): AiProvider {
  return {
    generate: async (req) => {
      const apiKey = getEnv('GEMINI_API_KEY');
      if (!apiKey) throw new Error('Missing GEMINI_API_KEY');
      const compiledPrompt = PROMPTS[req.task];
      const modelId = stripModelPrefix(req.model);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: compiledPrompt.systemPrompt }],
          },
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: formatUserDataMessage(req.input),
                },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            responseJsonSchema: req.jsonSchema,
          },
        }),
        signal: req.signal,
      });
      if (!res.ok) {
        console.warn('ai_provider_http_error', { status: res.status });
        throw new ProviderHttpError('gemini', res.status);
      }
      const data = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          thoughtsTokenCount?: number;
        };
      };
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      const text = parts
        .filter((part) => !part.thought)
        .map((part) => part.text ?? '')
        .join('');
      const usage = data.usageMetadata;
      return {
        output: parseJsonText(text),
        inputTokens: usage?.promptTokenCount ?? 0,
        // Thinking tokens are billed as output, so they belong in the cost.
        outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
      };
    },
  };
}

async function defaultVerifyJwt(token: string): Promise<{ userId: string } | null> {
  const url = Deno.env.get('SUPABASE_URL');
  const apikey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !apikey) return null;
  const headers = { authorization: `Bearer ${token}`, apikey };
  const res = await fetch(`${url}/auth/v1/user`, { headers });
  const data = res.ok ? ((await res.json()) as { id?: unknown }) : null;
  return typeof data?.id === 'string' ? { userId: data.id } : null;
}

function createDefaultCountRecentCalls(
  fetchImpl: typeof fetch,
  getEnv: (key: string) => string | undefined,
) {
  return async (userId: string, sinceIso: string): Promise<number> => {
    const url = getEnv('SUPABASE_URL');
    const apikey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
    // Fail closed: a missing config must block AI calls, not skip the limit.
    if (!url || !apikey) throw new Error('ai_calls counter not configured');
    const query = `user_id=eq.${encodeURIComponent(userId)}&created_at=gte.${encodeURIComponent(sinceIso)}&select=id`;
    const res = await fetchImpl(`${url}/rest/v1/ai_calls?${query}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${apikey}`,
        apikey,
        prefer: 'count=exact',
      },
    });
    if (!res.ok) throw new Error(`ai_calls count failed: ${res.status}`);
    const range = res.headers.get('content-range') ?? '';
    const totalStr = range.split('/')[1];
    const parsed = totalStr ? Number.parseInt(totalStr, 10) : Number.NaN;
    if (Number.isNaN(parsed)) throw new Error('ai_calls count missing');
    return parsed;
  };
}

async function defaultLogCall(row: AiCallLogRow): Promise<void> {
  const url = Deno.env.get('SUPABASE_URL');
  const apikey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !apikey) return;
  const headers = { authorization: `Bearer ${apikey}`, apikey, 'content-type': 'application/json' };
  const res = await fetch(`${url}/rest/v1/ai_calls`, {
    method: 'POST',
    headers,
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`ai_calls insert failed: ${res.status}`);
}

export function createAiGatewayHandler(deps: AiGatewayDeps = {}) {
  const {
    verifyJwt = defaultVerifyJwt,
    logCall = defaultLogCall,
    fetchImpl = fetch,
    getEnv = (key: string) => Deno.env.get(key),
    now = Date.now,
  } = deps;
  const countRecentCalls =
    deps.countRecentCalls ?? createDefaultCountRecentCalls(fetchImpl, getEnv);

  const providerMap: Record<AiProviderName, AiProvider> = {
    fake: deps.providers?.fake ?? fakeProvider,
    anthropic: deps.providers?.anthropic ?? createAnthropicProvider(fetchImpl, getEnv),
    gemini: deps.providers?.gemini ?? createGeminiProvider(fetchImpl, getEnv),
  };

  return async (req: Request): Promise<Response> => {
    const match = /^Bearer\s+(.+)$/i.exec((req.headers.get('authorization') ?? '').trim());
    let authUser: { userId: string } | null = null;
    try {
      authUser = match?.[1] ? await verifyJwt(match[1].trim()) : null;
    } catch {
      return fail('PROVIDER_ERROR', 'Auth check unavailable.', true, 503);
    }
    if (!authUser) return fail('UNAUTHENTICATED', 'Invalid or missing bearer token.', false, 401);

    const parsedReq = requestEnvelopeSchema.safeParse(await req.json().catch(() => null));
    if (!parsedReq.success) return fail('INPUT_INVALID', 'Invalid request envelope.', false, 400);

    const { task, input, requestId: request_id } = parsedReq.data;
    const baseRoute = routes[task];
    const override = deps.routeOverrides?.[task];
    const route: AiRouteConfig = override ? { ...baseRoute, ...override } : baseRoute;

    const sinceIso = new Date(now() - ONE_HOUR_MS).toISOString();
    let recentCount = 0;
    try {
      recentCount = await countRecentCalls(authUser.userId, sinceIso);
    } catch {
      return fail('PROVIDER_ERROR', 'Rate limit check unavailable.', true, 503);
    }
    if (recentCount >= HOURLY_CALL_LIMIT) {
      return fail('QUOTA_EXCEEDED', 'Hourly AI request limit exceeded.', false, 429);
    }

    const provider = providerMap[route.provider];
    const { model, promptVersion: prompt_version, schema } = route;
    const startedAt = now();
    let input_tokens = 0;
    let output_tokens = 0;

    const record = (validation_ok: boolean, error_code: AiErrorCode | null) => {
      const latency_ms = Math.max(0, now() - startedAt);
      const estimated_cost_microcents = estimateCostMicrocents(route, input_tokens, output_tokens);
      const row: AiCallLogRow = {
        request_id,
        user_id: authUser.userId,
        task,
        model,
        prompt_version,
        latency_ms,
        input_tokens,
        output_tokens,
        estimated_cost_microcents,
        cost_currency: route.costCurrency,
        validation_ok,
        error_code,
      };
      return logCall(row).catch(() => console.error('ai_calls log failed', { request_id, task }));
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), route.timeoutMs);
    try {
      for (const attempt of [1, 2] as const) {
        const res = await provider.generate({
          ...route,
          input,
          attempt,
          signal: controller.signal,
        });
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
    } catch (err) {
      const retryable = err instanceof ProviderHttpError ? err.retryable : true;
      await record(false, 'PROVIDER_ERROR');
      return fail('PROVIDER_ERROR', 'Provider call failed.', retryable);
    } finally {
      clearTimeout(timer);
    }
  };
}
