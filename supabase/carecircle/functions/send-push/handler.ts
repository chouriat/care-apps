import { z } from 'npm:zod@3.24.1';

export type StoredPushToken = {
  user_id: string;
  token: string;
  platform: 'ios' | 'android';
};

export type SendPushDeps = {
  fetchImpl?: typeof fetch;
  getEnv?: (key: string) => string | undefined;
  loadTokens?: (userIds: string[]) => Promise<StoredPushToken[]>;
  pruneTokens?: (tokens: string[]) => Promise<void>;
};

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
// Expo accepts "an array of up to 100 message objects" per request; more fails the whole request
// with PUSH_TOO_MANY_NOTIFICATIONS. Checked 15 Nov 2026:
// https://docs.expo.dev/push-notifications/sending-notifications/
const EXPO_MAX_MESSAGES_PER_REQUEST = 100;

const ALLOWED_PUSH_DATA_KEYS = new Set([
  'circleId',
  'doseEventId',
  'medicationId',
  'taskId',
  'appointmentId',
  'visitSummaryId',
  'reminderId',
  'type',
  'route',
]);

const HEALTH_DETAIL_TEXT_REGEX =
  /\b(?:\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|iu|units?|tablets?|capsules?|pills?|drops?|puffs?)|metformin|lisinopril|atorvastatin|amlodipine|omeprazole|insulin|warfarin|aspirin|ibuprofen|acetaminophen|paracetamol|amoxicillin|levothyroxine|prednisone|gabapentin|hydrochlorothiazide|losartan|albuterol|furosemide|pantoprazole|sertraline|prescription|diagnosis)\b/i;

const sendPushRequestSchema = z
  .object({
    userIds: z.array(z.string().uuid()).min(1).max(100),
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(500),
    // Ids (UUIDs) or short codes only, same rule as assertSafeNotificationPayload in @carecircle/core.
    data: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)).optional(),
  })
  .superRefine((val, ctx) => {
    if (HEALTH_DETAIL_TEXT_REGEX.test(val.title) || HEALTH_DETAIL_TEXT_REGEX.test(val.body)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Push title and body must be neutral and never contain medication names or dosages.',
      });
    }
    if (val.data) {
      for (const [key, value] of Object.entries(val.data)) {
        if (!ALLOWED_PUSH_DATA_KEYS.has(key) || HEALTH_DETAIL_TEXT_REGEX.test(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Push data key "${key}" or value is not allowed.`,
          });
        }
      }
    }
  });

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function createDefaultLoadTokens(
  fetchImpl: typeof fetch,
  getEnv: (key: string) => string | undefined,
) {
  return async (userIds: string[]): Promise<StoredPushToken[]> => {
    const url = getEnv('SUPABASE_URL');
    const serviceKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !serviceKey) {
      throw new Error('push_tokens store not configured');
    }
    const inList = userIds.map((id) => encodeURIComponent(id)).join(',');
    const res = await fetchImpl(
      `${url}/rest/v1/push_tokens?user_id=in.(${inList})&select=user_id,token,platform`,
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${serviceKey}`,
          apikey: serviceKey,
        },
      },
    );
    if (!res.ok) {
      throw new Error(`push_tokens query failed: ${res.status}`);
    }
    return (await res.json()) as StoredPushToken[];
  };
}

function createDefaultPruneTokens(
  fetchImpl: typeof fetch,
  getEnv: (key: string) => string | undefined,
) {
  return async (tokens: string[]): Promise<void> => {
    if (tokens.length === 0) return;
    const url = getEnv('SUPABASE_URL');
    const serviceKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !serviceKey) return;
    for (const token of tokens) {
      await fetchImpl(`${url}/rest/v1/push_tokens?token=eq.${encodeURIComponent(token)}`, {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${serviceKey}`,
          apikey: serviceKey,
        },
      });
    }
  };
}

export function createSendPushHandler(deps: SendPushDeps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const getEnv = deps.getEnv ?? ((key: string) => Deno.env.get(key));
  const loadTokens = deps.loadTokens ?? createDefaultLoadTokens(fetchImpl, getEnv);
  const pruneTokens = deps.pruneTokens ?? createDefaultPruneTokens(fetchImpl, getEnv);

  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') {
      return json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED' } }, 405);
    }

    const serviceKey = getEnv('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const authHeader = (req.headers.get('authorization') ?? '').trim();
    const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader);
    const callerToken = bearerMatch?.[1]?.trim() ?? '';

    if (!serviceKey || !constantTimeEquals(callerToken, serviceKey)) {
      return json(
        {
          ok: false,
          error: {
            code: 'UNAUTHENTICATED',
            message: 'Valid service-role authorization required.',
          },
        },
        401,
      );
    }

    const rawBody: unknown = await req.json().catch(() => null);
    const parsed = sendPushRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return json(
        {
          ok: false,
          error: {
            code: 'INPUT_INVALID',
            message: 'Invalid send-push request payload.',
          },
        },
        400,
      );
    }

    const uniqueUserIds = [...new Set(parsed.data.userIds)];
    let tokenRows: StoredPushToken[] = [];
    try {
      tokenRows = await loadTokens(uniqueUserIds);
    } catch {
      console.warn('send_push_token_lookup_failed');
      return json(
        {
          ok: false,
          error: {
            code: 'PROVIDER_ERROR',
            message: 'Failed to load recipient push tokens.',
          },
        },
        503,
      );
    }

    const uniqueTokens = [...new Set(tokenRows.map((row) => row.token))];
    if (uniqueTokens.length === 0) {
      return json({ ok: true, sent: 0, pruned: 0 });
    }

    const messages = uniqueTokens.map((to) => ({
      to,
      title: parsed.data.title,
      body: parsed.data.body,
      sound: 'default',
      ...(parsed.data.data ? { data: parsed.data.data } : {}),
    }));

    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
    };
    const expoAccessToken = getEnv('EXPO_ACCESS_TOKEN');
    if (expoAccessToken) {
      headers.authorization = `Bearer ${expoAccessToken}`;
    }

    let sent = 0;
    const staleTokens: string[] = [];
    try {
      for (let start = 0; start < messages.length; start += EXPO_MAX_MESSAGES_PER_REQUEST) {
        const batch = messages.slice(start, start + EXPO_MAX_MESSAGES_PER_REQUEST);
        const res = await fetchImpl(EXPO_PUSH_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify(batch),
        });
        if (!res.ok) {
          console.warn('send_push_expo_http_error', { status: res.status });
          return json(
            {
              ok: false,
              error: {
                code: 'PROVIDER_ERROR',
                message: 'Expo push service unavailable.',
              },
            },
            502,
          );
        }

        const payload = (await res.json()) as {
          data?: Array<{
            status?: string;
            details?: { error?: string };
          }>;
        };
        const tickets = Array.isArray(payload.data) ? payload.data : [];

        for (const [index, ticket] of tickets.entries()) {
          if (ticket.status === 'ok') {
            sent += 1;
          } else if (ticket.details?.error === 'DeviceNotRegistered') {
            const targetToken = batch[index]?.to;
            if (targetToken) {
              staleTokens.push(targetToken);
            }
          }
        }
      }

      if (staleTokens.length > 0) {
        await pruneTokens(staleTokens).catch(() => console.warn('send_push_prune_failed'));
      }

      return json({ ok: true, sent, pruned: staleTokens.length });
    } catch {
      console.warn('send_push_network_error');
      return json(
        {
          ok: false,
          error: {
            code: 'PROVIDER_ERROR',
            message: 'Push delivery failed.',
          },
        },
        502,
      );
    }
  };
}
