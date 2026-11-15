// F-5 [safety]: RevenueCat webhook -> `entitlements` table.
// Spec: docs/spec/carecircle.md > Part 1 > Entitlements.
// RevenueCat docs (checked 2026-11-15):
// - Webhooks: https://www.revenuecat.com/docs/integrations/webhooks
// - REST API v1 GET /subscribers/{app_user_id}: https://www.revenuecat.com/docs/api-v1/customers

export type CareCircleEntitlementId = 'carecircle_family';
export const CARECIRCLE_FAMILY_ENTITLEMENT: CareCircleEntitlementId = 'carecircle_family';

export interface EntitlementRow {
  user_id: string;
  entitlement: CareCircleEntitlementId;
  active: boolean;
  expires_at: string | null;
}

export interface EntitlementWriteStore {
  upsertEntitlement(row: EntitlementRow): Promise<{ error: { message: string } | null }>;
}

export interface RevenueCatSubscriberClient {
  getSubscriber(appUserId: string): Promise<unknown>;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_WEBHOOK_SECRET_LENGTH = 32;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function timingSafeEqualString(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < maxLen; i += 1) {
    const codeA = i < a.length ? a.charCodeAt(i) : 0;
    const codeB = i < b.length ? b.charCodeAt(i) : 0;
    diff |= codeA ^ codeB;
  }
  return diff === 0;
}

// RevenueCat event ids are UUIDs and types are upper-case words; anything else is not logged.
function safeLogToken(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}

function parseIsoTimestamp(raw: unknown, fieldName: string): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw !== 'string') {
    throw new Error(`Invalid ${fieldName} in RevenueCat subscriber payload`);
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new Error(`Unparseable ${fieldName} in RevenueCat subscriber payload`);
  }
  return new Date(ms).toISOString();
}

export function entitlementFromSubscriber(
  response: unknown,
  opts?: {
    entitlement?: CareCircleEntitlementId;
    allowSandbox?: boolean;
    now?: Date;
  },
): { active: boolean; expires_at: string | null } {
  if (!isPlainObject(response) || !isPlainObject(response.subscriber)) {
    throw new Error('Malformed RevenueCat subscriber response');
  }
  const subscriber = response.subscriber;
  if (!isPlainObject(subscriber.entitlements) || !isPlainObject(subscriber.subscriptions)) {
    throw new Error('Malformed RevenueCat subscriber entitlements or subscriptions');
  }

  const targetEntitlement: CareCircleEntitlementId =
    opts?.entitlement ?? CARECIRCLE_FAMILY_ENTITLEMENT;
  const allowSandbox = opts?.allowSandbox === true;
  const nowMs = (opts?.now ?? new Date()).getTime();

  const rawEnt = subscriber.entitlements[targetEntitlement];
  if (!isPlainObject(rawEnt)) {
    return { active: false, expires_at: null };
  }

  const entExpiresIso = parseIsoTimestamp(rawEnt.expires_date, 'expires_date');
  const entGraceIso = parseIsoTimestamp(
    rawEnt.grace_period_expires_date,
    'grace_period_expires_date',
  );

  const productId =
    typeof rawEnt.product_identifier === 'string' ? rawEnt.product_identifier : null;
  // Subscriptions live in `subscriptions`; one-time (lifetime) purchases live in
  // `non_subscriptions[product]`, a list of purchases, of which the last one counts.
  let rawSub: unknown = productId ? subscriber.subscriptions[productId] : undefined;
  if (!isPlainObject(rawSub) && productId && isPlainObject(subscriber.non_subscriptions)) {
    const purchases = subscriber.non_subscriptions[productId];
    if (Array.isArray(purchases) && purchases.length > 0) {
      rawSub = purchases[purchases.length - 1];
    }
  }

  if (!isPlainObject(rawSub)) {
    return { active: false, expires_at: entExpiresIso };
  }

  const refundedIso = parseIsoTimestamp(rawSub.refunded_at, 'refunded_at');
  if (refundedIso !== null) {
    return { active: false, expires_at: refundedIso };
  }

  const subExpiresIso = parseIsoTimestamp(rawSub.expires_date, 'subscription.expires_date');
  const subGraceIso = parseIsoTimestamp(
    rawSub.grace_period_expires_date,
    'subscription.grace_period_expires_date',
  );

  const primaryExpiresIso = entExpiresIso ?? subExpiresIso;
  const graceExpiresIso = entGraceIso ?? subGraceIso;

  let effectiveExpiresIso: string | null = primaryExpiresIso;
  if (graceExpiresIso !== null) {
    if (
      effectiveExpiresIso === null ||
      Date.parse(graceExpiresIso) > Date.parse(effectiveExpiresIso)
    ) {
      effectiveExpiresIso = graceExpiresIso;
    }
  }

  if (rawSub.is_sandbox === true && !allowSandbox) {
    return { active: false, expires_at: effectiveExpiresIso };
  }

  if (effectiveExpiresIso === null) {
    return { active: true, expires_at: null };
  }

  const active = Date.parse(effectiveExpiresIso) > nowMs;
  return { active, expires_at: effectiveExpiresIso };
}

function extractCandidateUuidUserIds(eventObj: Record<string, unknown>): string[] {
  const candidates: unknown[] = [
    eventObj.app_user_id,
    eventObj.original_app_user_id,
    ...(Array.isArray(eventObj.aliases) ? eventObj.aliases : []),
    ...(Array.isArray(eventObj.transferred_from) ? eventObj.transferred_from : []),
    ...(Array.isArray(eventObj.transferred_to) ? eventObj.transferred_to : []),
  ];

  const seen = new Set<string>();
  const uuids: string[] = [];
  for (const item of candidates) {
    if (typeof item === 'string' && UUID_REGEX.test(item)) {
      const normalized = item.toLowerCase();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        uuids.push(normalized);
      }
    }
  }
  return uuids;
}

export interface ProcessRevenueCatWebhookInput {
  authHeader: string | null | undefined;
  expectedWebhookSecret: string | null | undefined;
  payload: unknown;
  store: EntitlementWriteStore;
  revenueCat: RevenueCatSubscriberClient;
  allowSandbox?: boolean;
  now?: Date;
}

export interface ProcessRevenueCatWebhookResult {
  status: number;
  ok: boolean;
  errorCode?: string;
}

export async function processRevenueCatWebhook(
  input: ProcessRevenueCatWebhookInput,
): Promise<ProcessRevenueCatWebhookResult> {
  const secret = input.expectedWebhookSecret;
  if (typeof secret !== 'string' || secret.length < MIN_WEBHOOK_SECRET_LENGTH) {
    return { status: 500, ok: false, errorCode: 'WEBHOOK_NOT_CONFIGURED' };
  }

  const expectedHeader = `Bearer ${secret}`;
  if (
    typeof input.authHeader !== 'string' ||
    !timingSafeEqualString(input.authHeader, expectedHeader)
  ) {
    return { status: 401, ok: false, errorCode: 'UNAUTHORIZED' };
  }

  if (!isPlainObject(input.payload) || !isPlainObject(input.payload.event)) {
    return { status: 400, ok: false, errorCode: 'INVALID_PAYLOAD' };
  }

  const eventObj = input.payload.event;
  if (typeof eventObj.type !== 'string' || eventObj.type.trim().length === 0) {
    return { status: 400, ok: false, errorCode: 'INVALID_PAYLOAD' };
  }

  if (eventObj.type === 'TEST') {
    return { status: 200, ok: true };
  }

  const userIds = extractCandidateUuidUserIds(eventObj);
  if (userIds.length === 0) {
    return { status: 200, ok: true };
  }

  for (const userId of userIds) {
    let state: { active: boolean; expires_at: string | null };
    try {
      const subscriberPayload = await input.revenueCat.getSubscriber(userId);
      state = entitlementFromSubscriber(subscriberPayload, {
        entitlement: CARECIRCLE_FAMILY_ENTITLEMENT,
        allowSandbox: input.allowSandbox === true,
        now: input.now,
      });
    } catch {
      return { status: 502, ok: false, errorCode: 'UPSTREAM_ERROR' };
    }

    try {
      const writeResult = await input.store.upsertEntitlement({
        user_id: userId,
        entitlement: CARECIRCLE_FAMILY_ENTITLEMENT,
        active: state.active,
        expires_at: state.expires_at,
      });
      if (writeResult.error !== null) {
        return { status: 500, ok: false, errorCode: 'STORE_ERROR' };
      }
    } catch {
      return { status: 500, ok: false, errorCode: 'STORE_ERROR' };
    }
  }

  return { status: 200, ok: true };
}

export interface RevenueCatWebhookHandlerDeps {
  getEnv?: (key: string) => string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export function createRevenueCatWebhookHandler(
  deps: RevenueCatWebhookHandlerDeps = {},
): (req: Request) => Promise<Response> {
  const getEnv = deps.getEnv ?? ((key: string) => Deno.env.get(key));
  const fetchFn = deps.fetchImpl ?? fetch;
  const nowFn = deps.now ?? (() => new Date());

  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') {
      return Response.json({ ok: false, errorCode: 'METHOD_NOT_ALLOWED' }, { status: 405 });
    }

    const webhookSecret = getEnv('REVENUECAT_WEBHOOK_SECRET');
    const rcApiKey = getEnv('REVENUECAT_SECRET_API_KEY');
    const supabaseUrl = getEnv('SUPABASE_URL');
    const serviceRoleKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
    const allowSandbox = getEnv('REVENUECAT_ALLOW_SANDBOX') === 'true';

    if (
      !webhookSecret ||
      webhookSecret.length < MIN_WEBHOOK_SECRET_LENGTH ||
      !rcApiKey ||
      !supabaseUrl ||
      !serviceRoleKey
    ) {
      return Response.json({ ok: false, errorCode: 'WEBHOOK_NOT_CONFIGURED' }, { status: 500 });
    }

    const authHeader = req.headers.get('authorization');
    if (
      typeof authHeader !== 'string' ||
      !timingSafeEqualString(authHeader, `Bearer ${webhookSecret}`)
    ) {
      return Response.json({ ok: false, errorCode: 'UNAUTHORIZED' }, { status: 401 });
    }

    let payload: unknown;
    try {
      payload = await req.json();
    } catch {
      return Response.json({ ok: false, errorCode: 'INVALID_JSON' }, { status: 400 });
    }

    const revenueCat: RevenueCatSubscriberClient = {
      async getSubscriber(appUserId: string) {
        const res = await fetchFn(
          `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(appUserId)}`,
          {
            method: 'GET',
            headers: {
              authorization: `Bearer ${rcApiKey}`,
              accept: 'application/json',
            },
          },
        );
        if (!res.ok) {
          throw new Error(`RevenueCat HTTP ${res.status}`);
        }
        return await res.json();
      },
    };

    const store: EntitlementWriteStore = {
      async upsertEntitlement(row: EntitlementRow) {
        const baseUrl = supabaseUrl.replace(/\/$/, '');
        const res = await fetchFn(
          `${baseUrl}/rest/v1/entitlements?on_conflict=user_id,entitlement`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              apikey: serviceRoleKey,
              authorization: `Bearer ${serviceRoleKey}`,
              prefer: 'resolution=merge-duplicates,return=minimal',
            },
            body: JSON.stringify(row),
          },
        );
        if (!res.ok) {
          return { error: { message: `Database HTTP ${res.status}` } };
        }
        return { error: null };
      },
    };

    const event = isPlainObject(payload) && isPlainObject(payload.event) ? payload.event : {};
    const result = await processRevenueCatWebhook({
      authHeader,
      expectedWebhookSecret: webhookSecret,
      payload,
      store,
      revenueCat,
      allowSandbox,
      now: nowFn(),
    });

    // Only the event id, its type and an error code. Never the body, a header, a key or a user id.
    console.log(
      JSON.stringify({
        fn: 'revenuecat-webhook',
        event_id: safeLogToken(event.id),
        event_type: safeLogToken(event.type),
        status: result.status,
        error_code: result.errorCode ?? null,
      }),
    );

    return Response.json(
      result.errorCode ? { ok: result.ok, errorCode: result.errorCode } : { ok: result.ok },
      { status: result.status },
    );
  };
}
