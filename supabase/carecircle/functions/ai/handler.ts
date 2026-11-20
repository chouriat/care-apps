import { z } from 'npm:zod@3.24.1';
import {
  createPostgrestCircleEntitlementStore,
  verifyCircleFamilyEntitlement,
  type CircleOwnerLookupStore,
  type ServerEntitlementVerification,
} from '../_shared/entitlements.ts';
import { PROMPTS } from './prompts.ts';
import {
  estimateCostMicrocents,
  fakeProvider,
  routes,
  visitInputSchema,
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
  checkPrescriptionCircleAccess?: (opts: { userId: string; circleId: string }) => Promise<boolean>;
  readPrescriptionPhoto?: (opts: {
    imagePath: string;
  }) => Promise<{ bytes: Uint8Array; contentType: string } | null>;
  checkCircleMedicationIds?: (opts: {
    circleId: string;
    medicationIds: string[];
  }) => Promise<boolean>;
  checkCircleFamilyEntitlement?: (opts: {
    circleId: string;
    now: Date;
  }) => Promise<ServerEntitlementVerification>;
  entitlementStore?: CircleOwnerLookupStore;
  readVisitAudio?: (opts: {
    audioPath: string;
  }) => Promise<{ bytes: Uint8Array; contentType: string } | null>;
  deleteVisitAudio?: (opts: { audioPath: string }) => Promise<void>;
  routeOverrides?: Partial<Record<AiTaskName, Partial<AiRouteConfig>>>;
  fetchImpl?: typeof fetch;
  getEnv?: (key: string) => string | undefined;
  now?: () => number;
};

const HOURLY_CALL_LIMIT = 60;
const ONE_HOUR_MS = 3_600_000;
const MAX_PRESCRIPTION_PHOTO_BYTES = 2 * 1024 * 1024;
const MAX_VISIT_AUDIO_BYTES = 10 * 1024 * 1024;

const RX_IMAGE_PATH_REGEX =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/;

const VISIT_AUDIO_PATH_REGEX =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.m4a$/;

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 8192;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }
  return btoa(chunks.join(''));
}

function isJpegBytes(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

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
  // Escape '<' so text typed by a user cannot close the data tag early.
  const data = JSON.stringify(input).replace(/</g, '\\u003c');
  return `<user_input_data>\n${data}\n</user_input_data>`;
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
      const systemPrompt = req.systemPromptOverride ?? compiledPrompt.systemPrompt;
      const userDataText = formatUserDataMessage(req.input);
      const userContent =
        req.image && typeof req.input.text !== 'string'
          ? [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: req.image.mimeType,
                  data: bytesToBase64(req.image.bytes),
                },
              },
              {
                type: 'text',
                text: userDataText,
              },
            ]
          : userDataText;
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
          system: systemPrompt,
          messages: [
            {
              role: 'user',
              content: userContent,
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
      const systemPrompt = req.systemPromptOverride ?? compiledPrompt.systemPrompt;
      const modelId = stripModelPrefix(req.model);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;
      const userParts: Array<Record<string, unknown>> = [
        {
          text: formatUserDataMessage(req.input),
        },
      ];
      if (req.image) {
        userParts.push({
          inlineData: {
            mimeType: req.image.mimeType,
            data: bytesToBase64(req.image.bytes),
          },
        });
      }
      if (req.audio) {
        userParts.push({
          inlineData: {
            mimeType: req.audio.mimeType,
            data: bytesToBase64(req.audio.bytes),
          },
        });
      }
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemPrompt }],
          },
          contents: [
            {
              role: 'user',
              parts: userParts,
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

function createDefaultCheckPrescriptionCircleAccess(
  fetchImpl: typeof fetch,
  getEnv: (key: string) => string | undefined,
) {
  return async ({ userId, circleId }: { userId: string; circleId: string }): Promise<boolean> => {
    const url = getEnv('SUPABASE_URL');
    const apikey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !apikey) throw new Error('circle_members check not configured');
    const query = `circle_id=eq.${encodeURIComponent(circleId)}&user_id=eq.${encodeURIComponent(userId)}&role=in.(owner,helper)&select=role`;
    const res = await fetchImpl(`${url}/rest/v1/circle_members?${query}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${apikey}`,
        apikey,
      },
    });
    if (!res.ok) throw new Error(`circle_members check failed: ${res.status}`);
    const rows = (await res.json()) as Array<{ role?: unknown }>;
    return Array.isArray(rows) && rows.some((row) => row.role === 'owner' || row.role === 'helper');
  };
}

function createDefaultReadPrescriptionPhoto(
  fetchImpl: typeof fetch,
  getEnv: (key: string) => string | undefined,
) {
  return async ({
    imagePath,
  }: {
    imagePath: string;
  }): Promise<{ bytes: Uint8Array; contentType: string } | null> => {
    const url = getEnv('SUPABASE_URL');
    const apikey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !apikey) throw new Error('prescription-photos storage not configured');
    const res = await fetchImpl(`${url}/storage/v1/object/prescription-photos/${imagePath}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${apikey}`,
        apikey,
      },
    });
    if (res.status === 404 || res.status === 400) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`prescription-photos read failed: ${res.status}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') ?? '';
    return { bytes, contentType };
  };
}

function createDefaultCheckCircleMedicationIds(
  fetchImpl: typeof fetch,
  getEnv: (key: string) => string | undefined,
) {
  return async ({
    circleId,
    medicationIds,
  }: {
    circleId: string;
    medicationIds: string[];
  }): Promise<boolean> => {
    const uniqueIds = Array.from(new Set(medicationIds.map((id) => id.toLowerCase())));
    if (uniqueIds.length === 0) return true;
    const url = getEnv('SUPABASE_URL');
    const apikey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !apikey) throw new Error('medications lookup not configured');
    const query = `circle_id=eq.${encodeURIComponent(circleId)}&id=in.(${uniqueIds.map((id) => encodeURIComponent(id)).join(',')})&select=id`;
    const res = await fetchImpl(`${url}/rest/v1/medications?${query}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${apikey}`,
        apikey,
      },
    });
    if (!res.ok) throw new Error(`medications check failed: ${res.status}`);
    const rows = (await res.json()) as Array<{ id?: unknown }>;
    if (!Array.isArray(rows)) throw new Error('medications check returned non-array');
    const foundIds = new Set(
      rows
        .map((r) => (typeof r.id === 'string' ? r.id.toLowerCase() : ''))
        .filter((id) => id.length > 0),
    );
    return uniqueIds.every((id) => foundIds.has(id));
  };
}

function createDefaultReadVisitAudio(
  fetchImpl: typeof fetch,
  getEnv: (key: string) => string | undefined,
) {
  return async ({
    audioPath,
  }: {
    audioPath: string;
  }): Promise<{ bytes: Uint8Array; contentType: string } | null> => {
    const url = getEnv('SUPABASE_URL');
    const apikey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !apikey) throw new Error('visit-audio storage not configured');
    const res = await fetchImpl(`${url}/storage/v1/object/visit-audio/${audioPath}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${apikey}`,
        apikey,
      },
    });
    if (res.status === 404 || res.status === 400) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`visit-audio read failed: ${res.status}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') ?? '';
    return { bytes, contentType };
  };
}

function createDefaultDeleteVisitAudio(
  fetchImpl: typeof fetch,
  getEnv: (key: string) => string | undefined,
) {
  return async ({ audioPath }: { audioPath: string }): Promise<void> => {
    const url = getEnv('SUPABASE_URL');
    const apikey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !apikey) return;
    await fetchImpl(`${url}/storage/v1/object/visit-audio`, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${apikey}`,
        apikey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ prefixes: [audioPath] }),
    });
  };
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
  const checkPrescriptionCircleAccess =
    deps.checkPrescriptionCircleAccess ??
    createDefaultCheckPrescriptionCircleAccess(fetchImpl, getEnv);
  const readPrescriptionPhoto =
    deps.readPrescriptionPhoto ?? createDefaultReadPrescriptionPhoto(fetchImpl, getEnv);
  const checkCircleMedicationIds =
    deps.checkCircleMedicationIds ?? createDefaultCheckCircleMedicationIds(fetchImpl, getEnv);
  const entitlementStore =
    deps.entitlementStore ?? createPostgrestCircleEntitlementStore(fetchImpl, getEnv);
  const checkCircleFamilyEntitlement =
    deps.checkCircleFamilyEntitlement ??
    (({ circleId, now: checkNow }: { circleId: string; now: Date }) =>
      verifyCircleFamilyEntitlement({ circleId, store: entitlementStore, now: checkNow }));
  const readVisitAudio = deps.readVisitAudio ?? createDefaultReadVisitAudio(fetchImpl, getEnv);
  const deleteVisitAudio =
    deps.deleteVisitAudio ?? createDefaultDeleteVisitAudio(fetchImpl, getEnv);

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

    let providerImage: { bytes: Uint8Array; mimeType: 'image/jpeg' } | undefined;
    let providerInput: Record<string, unknown> = input;
    let sttInputTokens = 0;
    let sttOutputTokens = 0;
    let sttCostMicrocents = 0;

    const useCiFake =
      getEnv('CARECIRCLE_CI_FAKE_AI') === '1' &&
      ['http://kong:8000', 'http://127.0.0.1:54321'].includes(
        (getEnv('SUPABASE_URL') ?? '').trim().replace(/\/+$/, ''),
      );
    const provider = useCiFake ? providerMap.fake : providerMap[route.provider];
    const { model, promptVersion: prompt_version, schema } = route;
    const startedAt = now();
    let input_tokens = 0;
    let output_tokens = 0;

    const record = (validation_ok: boolean, error_code: AiErrorCode | null) => {
      const latency_ms = Math.max(0, now() - startedAt);
      const totalInputTokens = sttInputTokens + input_tokens;
      const totalOutputTokens = sttOutputTokens + output_tokens;
      const estimated_cost_microcents =
        sttCostMicrocents + estimateCostMicrocents(route, input_tokens, output_tokens);
      const row: AiCallLogRow = {
        request_id,
        user_id: authUser.userId,
        task,
        model,
        prompt_version,
        latency_ms,
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        estimated_cost_microcents,
        cost_currency: route.costCurrency,
        validation_ok,
        error_code,
      };
      return logCall(row).catch(() => console.error('ai_calls log failed', { request_id, task }));
    };

    if (task === 'carecircle.extractPrescription') {
      const rawImagePath = input.imagePath;
      const pathMatch =
        typeof rawImagePath === 'string' ? RX_IMAGE_PATH_REGEX.exec(rawImagePath) : null;
      if (!pathMatch) {
        return fail('INPUT_INVALID', 'Invalid prescription photo path.', false, 400);
      }
      const circleId = pathMatch[1]!;
      const imagePath = rawImagePath as string;

      let hasAccess = false;
      try {
        hasAccess = await checkPrescriptionCircleAccess({ userId: authUser.userId, circleId });
      } catch {
        return fail('PROVIDER_ERROR', 'Circle access check unavailable.', true, 503);
      }
      if (!hasAccess) {
        return fail('INPUT_INVALID', 'Not authorized to read this prescription photo.', false, 403);
      }

      let photo: { bytes: Uint8Array; contentType: string } | null = null;
      try {
        photo = await readPrescriptionPhoto({ imagePath });
      } catch {
        return fail('PROVIDER_ERROR', 'Prescription photo storage unavailable.', true, 503);
      }
      if (
        !photo ||
        !/^image\/jpeg(?:\s*;.*)?$/i.test(photo.contentType.trim()) ||
        photo.bytes.byteLength === 0 ||
        photo.bytes.byteLength > MAX_PRESCRIPTION_PHOTO_BYTES ||
        !isJpegBytes(photo.bytes)
      ) {
        return fail('INPUT_INVALID', 'Invalid or missing prescription photo.', false, 400);
      }
      providerImage = { bytes: photo.bytes, mimeType: 'image/jpeg' };
    } else if (task === 'carecircle.summarizeVisit') {
      const parsedVisit = visitInputSchema.safeParse(input);
      if (!parsedVisit.success) {
        return fail('INPUT_INVALID', 'Invalid summarizeVisit input.', false, 400);
      }

      let circleId: string;
      const audioPath = parsedVisit.data.audioPath;
      if (audioPath !== undefined) {
        const audioMatch = VISIT_AUDIO_PATH_REGEX.exec(audioPath);
        if (!audioMatch) {
          return fail('INPUT_INVALID', 'Invalid visit audio path.', false, 400);
        }
        const pathCircleId = audioMatch[1]!;
        if (
          parsedVisit.data.circleId !== undefined &&
          parsedVisit.data.circleId.toLowerCase() !== pathCircleId
        ) {
          return fail('INPUT_INVALID', 'circleId does not match audioPath.', false, 400);
        }
        circleId = pathCircleId;
      } else {
        if (!parsedVisit.data.circleId) {
          return fail('INPUT_INVALID', 'circleId is required with text.', false, 400);
        }
        circleId = parsedVisit.data.circleId.toLowerCase();
      }

      let planCheck: ServerEntitlementVerification;
      try {
        planCheck = await checkCircleFamilyEntitlement({ circleId, now: new Date(now()) });
      } catch {
        return fail('PROVIDER_ERROR', 'Entitlement check unavailable.', true, 503);
      }
      if (!planCheck.allowed) {
        if (planCheck.reason === 'STORE_ERROR') {
          return fail('PROVIDER_ERROR', 'Entitlement check unavailable.', true, 503);
        }
        return fail('QUOTA_EXCEEDED', 'Family plan required for visit summaries.', false, 402);
      }

      let hasAccess = false;
      try {
        hasAccess = await checkPrescriptionCircleAccess({ userId: authUser.userId, circleId });
      } catch {
        return fail('PROVIDER_ERROR', 'Circle access check unavailable.', true, 503);
      }
      if (!hasAccess) {
        return fail('INPUT_INVALID', 'Invalid visit input.', false, 403);
      }

      if (parsedVisit.data.knownMeds.length > 0) {
        let medsBelong = false;
        try {
          medsBelong = await checkCircleMedicationIds({
            circleId,
            medicationIds: parsedVisit.data.knownMeds.map((m) => m.id),
          });
        } catch {
          return fail('PROVIDER_ERROR', 'Medication check unavailable.', true, 503);
        }
        if (!medsBelong) {
          return fail('INPUT_INVALID', 'Invalid knownMeds for circle.', false, 400);
        }
      }

      if (audioPath !== undefined) {
        let transcribedText: string | null = null;
        try {
          let audioObj: { bytes: Uint8Array; contentType: string } | null = null;
          try {
            audioObj = await readVisitAudio({ audioPath });
          } catch {
            return fail('PROVIDER_ERROR', 'Visit audio storage unavailable.', true, 503);
          }

          const ct = audioObj?.contentType.trim() ?? '';
          if (
            !audioObj ||
            !/^audio\/(?:mp4|m4a|x-m4a)(?:\s*;.*)?$/i.test(ct) ||
            audioObj.bytes.byteLength === 0 ||
            audioObj.bytes.byteLength > MAX_VISIT_AUDIO_BYTES
          ) {
            return fail('INPUT_INVALID', 'Invalid or missing visit audio.', false, 400);
          }

          const audioMimeType: 'audio/mp4' | 'audio/m4a' = /^audio\/m4a/i.test(ct)
            ? 'audio/m4a'
            : 'audio/mp4';

          const sttConfig = route.speechToText ?? routes['carecircle.summarizeVisit'].speechToText!;
          const sttProvider = useCiFake ? providerMap.fake : providerMap[sttConfig.provider];
          const sttController = new AbortController();
          const sttTimer = setTimeout(() => sttController.abort(), sttConfig.timeoutMs);

          try {
            for (const attempt of [1, 2] as const) {
              const sttRes = await sttProvider.generate({
                task,
                provider: sttConfig.provider,
                model: sttConfig.model,
                promptFile: route.promptFile,
                promptVersion: sttConfig.promptVersion,
                schema: sttConfig.schema,
                jsonSchema: sttConfig.jsonSchema,
                timeoutMs: sttConfig.timeoutMs,
                inputMicrocentsPer1k: sttConfig.inputMicrocentsPer1k,
                outputMicrocentsPer1k: sttConfig.outputMicrocentsPer1k,
                costCurrency: sttConfig.costCurrency,
                input: { task: 'transcribeVisitAudio' },
                audio: { bytes: audioObj.bytes, mimeType: audioMimeType },
                systemPromptOverride: sttConfig.systemPrompt,
                attempt,
                signal: sttController.signal,
              });
              sttInputTokens += sttRes.inputTokens;
              sttOutputTokens += sttRes.outputTokens;
              const parsedStt = sttConfig.schema.safeParse(sttRes.output);
              if (parsedStt.success) {
                transcribedText = parsedStt.data.transcript;
                break;
              }
            }
            sttCostMicrocents = estimateCostMicrocents(sttConfig, sttInputTokens, sttOutputTokens);
            if (transcribedText === null) {
              await record(false, 'SCHEMA_INVALID');
              return fail('SCHEMA_INVALID', 'Audio transcription failed validation twice.', false);
            }
          } catch (err) {
            sttCostMicrocents = estimateCostMicrocents(sttConfig, sttInputTokens, sttOutputTokens);
            const retryable = err instanceof ProviderHttpError ? err.retryable : true;
            await record(false, 'PROVIDER_ERROR');
            return fail('PROVIDER_ERROR', 'Audio transcription provider call failed.', retryable);
          } finally {
            clearTimeout(sttTimer);
          }
        } finally {
          await deleteVisitAudio({ audioPath }).catch(() => undefined);
        }

        const combinedTranscript = parsedVisit.data.text
          ? `${transcribedText}\n${parsedVisit.data.text}`
          : transcribedText;
        providerInput = {
          text: combinedTranscript,
          knownMeds: parsedVisit.data.knownMeds,
        };
      } else {
        providerInput = {
          text: parsedVisit.data.text,
          knownMeds: parsedVisit.data.knownMeds,
        };
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), route.timeoutMs);
    try {
      for (const attempt of [1, 2] as const) {
        const res = await provider.generate({
          ...route,
          input: providerInput,
          ...(providerImage ? { image: providerImage } : {}),
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
