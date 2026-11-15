// F-5 [safety]: RevenueCat webhook -> `entitlements` table (spec Part 1 > Entitlements).
//
// Design these tests fix (RevenueCat's own advice, read 15 Nov 2026 at
// https://www.revenuecat.com/docs/integrations/webhooks : "we recommend calling the GET /subscribers
// REST API endpoint after receiving any webhook"):
// - The webhook body only says WHICH users changed. The function then asks RevenueCat
//   (GET https://api.revenuecat.com/v1/subscribers/{app_user_id}) for the current state and writes that.
//   So a forged or replayed body can never grant access, events that arrive late or out of order
//   cannot undo a renewal, and refunds, billing-issue grace periods, product changes, transfers and
//   new event types are all handled the same way.
// - Anything that fails returns a non-200 so RevenueCat retries (up to 5 times over about 80 minutes),
//   and the existing row is left as it was.
import {
  createRevenueCatWebhookHandler,
  entitlementFromSubscriber,
  processRevenueCatWebhook,
  type EntitlementRow,
  type EntitlementWriteStore,
  type RevenueCatSubscriberClient,
} from './handler.ts';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const USER_C = 'cccccccc-abcd-4ef0-8abc-cccccccccccc'; // has letters, to check lower-casing
const WEBHOOK_SECRET = 'rc-webhook-secret-0123456789abcdef0123456789abcdef';
const RC_API_KEY = 'sk_test_revenuecat_secret_api_key_123456';
const NOW = new Date('2026-11-15T10:00:00.000Z');
const FUTURE = '2026-12-15T10:00:00Z';
const PAST = '2026-11-01T10:00:00Z';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
};
const assertEquals = (actual: unknown, expected: unknown, msg: string): void => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`Assertion failed: ${msg}\n  actual:   ${a}\n  expected: ${e}`);
};

// ---- GET /v1/subscribers/{id} response fixtures (shape from
// https://www.revenuecat.com/docs/api-v1/customers, read 15 Nov 2026) ----

type SubFixture = {
  expires?: string | null;
  grace?: string | null;
  sandbox?: boolean;
  refundedAt?: string | null;
  product?: string;
  entitlementId?: string;
};

function subscriberResponse(f: SubFixture | null) {
  const product = f?.product ?? 'carecircle_family_monthly';
  return {
    request_date: NOW.toISOString(),
    request_date_ms: NOW.getTime(),
    subscriber: {
      original_app_user_id: USER_A,
      first_seen: '2026-11-01T10:00:00Z',
      management_url: null,
      non_subscriptions: {},
      entitlements: f
        ? {
            [f.entitlementId ?? 'carecircle_family']: {
              expires_date: f.expires === undefined ? FUTURE : f.expires,
              grace_period_expires_date: f.grace ?? null,
              product_identifier: product,
              purchase_date: '2026-11-15T09:00:00Z',
            },
          }
        : {},
      subscriptions: f
        ? {
            [product]: {
              expires_date: f.expires === undefined ? FUTURE : f.expires,
              grace_period_expires_date: f.grace ?? null,
              is_sandbox: f.sandbox ?? false,
              original_purchase_date: '2026-11-15T09:00:00Z',
              purchase_date: '2026-11-15T09:00:00Z',
              period_type: 'normal',
              store: 'app_store',
              ownership_type: 'PURCHASED',
              refunded_at: f.refundedAt ?? null,
              unsubscribe_detected_at: null,
              billing_issues_detected_at: null,
            },
          }
        : {},
    },
  };
}

// ---- fakes ----

function memoryStore(initial: EntitlementRow[] = []) {
  const rows = new Map<string, EntitlementRow>();
  for (const r of initial) rows.set(`${r.user_id}:${r.entitlement}`, r);
  let failWrites = false;
  const store: EntitlementWriteStore = {
    async upsertEntitlement(row) {
      if (failWrites) return { error: { message: 'db down' } };
      rows.set(`${row.user_id}:${row.entitlement}`, { ...row });
      return { error: null };
    },
  };
  return {
    rows,
    store,
    failWrites() {
      failWrites = true;
    },
  };
}

function fakeRevenueCat(byUser: Record<string, SubFixture | null | 'error'>) {
  const calls: string[] = [];
  const client: RevenueCatSubscriberClient = {
    async getSubscriber(appUserId) {
      calls.push(appUserId);
      const f = byUser[appUserId];
      if (f === 'error') throw new Error('RevenueCat 503');
      return subscriberResponse(f ?? null);
    },
  };
  return { client, calls };
}

const event = (overrides: Record<string, unknown> = {}) => ({
  api_version: '1.0',
  event: {
    id: 'evt-1',
    type: 'INITIAL_PURCHASE',
    app_user_id: USER_A,
    original_app_user_id: USER_A,
    aliases: [USER_A],
    entitlement_ids: ['carecircle_family'],
    environment: 'PRODUCTION',
    period_type: 'NORMAL',
    expiration_at_ms: Date.parse(FUTURE),
    event_timestamp_ms: NOW.getTime(),
    ...overrides,
  },
});

async function run(opts: {
  payload: unknown;
  rc: RevenueCatSubscriberClient;
  store: EntitlementWriteStore;
  authHeader?: string | null;
  expectedWebhookSecret?: string;
  allowSandbox?: boolean;
}) {
  return await processRevenueCatWebhook({
    authHeader: opts.authHeader === undefined ? `Bearer ${WEBHOOK_SECRET}` : opts.authHeader,
    expectedWebhookSecret: opts.expectedWebhookSecret ?? WEBHOOK_SECRET,
    payload: opts.payload,
    store: opts.store,
    revenueCat: opts.rc,
    allowSandbox: opts.allowSandbox ?? false,
    now: NOW,
  });
}

const rowA = (active: boolean, expires_at: string | null): EntitlementRow => ({
  user_id: USER_A,
  entitlement: 'carecircle_family',
  active,
  expires_at,
});

// ---- authentication ----

Deno.test('rejects calls without the exact Authorization header and writes nothing', async () => {
  const { rows, store } = memoryStore();
  const rc = fakeRevenueCat({ [USER_A]: {} });
  for (const authHeader of [
    null,
    '',
    'Bearer ',
    'Bearer wrong-secret',
    `Bearer ${WEBHOOK_SECRET.slice(0, -1)}`, // prefix of the secret
    `Bearer ${WEBHOOK_SECRET}x`, // secret plus extra
    `Bearer ${WEBHOOK_SECRET.toUpperCase()}`,
    WEBHOOK_SECRET, // no "Bearer "
    `Basic ${WEBHOOK_SECRET}`,
    ` Bearer ${WEBHOOK_SECRET}`,
  ]) {
    const res = await run({ payload: event(), rc: rc.client, store, authHeader });
    assertEquals(
      { status: res.status, ok: res.ok },
      { status: 401, ok: false },
      `header ${JSON.stringify(authHeader)} rejected`,
    );
  }
  assertEquals(rows.size, 0, 'no row written');
  assertEquals(rc.calls, [], 'RevenueCat not called for unauthenticated requests');
});

Deno.test(
  'a missing or weak server secret fails closed with 500 (so RevenueCat retries once fixed)',
  async () => {
    const { rows, store } = memoryStore();
    const rc = fakeRevenueCat({ [USER_A]: {} });
    for (const [authHeader, expectedWebhookSecret] of [
      ['Bearer ', ''],
      ['Bearer short', 'short'],
      [`Bearer ${'x'.repeat(31)}`, 'x'.repeat(31)], // under 32 characters is not a real secret
    ] as const) {
      const res = await run({
        payload: event(),
        rc: rc.client,
        store,
        authHeader,
        expectedWebhookSecret,
      });
      assertEquals(
        { status: res.status, ok: res.ok, errorCode: res.errorCode },
        { status: 500, ok: false, errorCode: 'WEBHOOK_NOT_CONFIGURED' },
        `expected secret of length ${expectedWebhookSecret.length} fails closed`,
      );
    }
    assertEquals(rows.size, 0, 'no row written');
    assertEquals(rc.calls, [], 'RevenueCat not called');
  },
);

// ---- the state always comes from RevenueCat, never from the body ----

Deno.test(
  'INITIAL_PURCHASE: syncs from RevenueCat and writes active = true with its expiry',
  async () => {
    const { rows, store } = memoryStore();
    const rc = fakeRevenueCat({ [USER_A]: { expires: FUTURE } });
    const res = await run({ payload: event(), rc: rc.client, store });
    assertEquals({ status: res.status, ok: res.ok }, { status: 200, ok: true }, '200');
    assertEquals(rc.calls, [USER_A], 'asked RevenueCat about user A once');
    assertEquals(
      rows.get(`${USER_A}:carecircle_family`),
      rowA(true, '2026-12-15T10:00:00.000Z'),
      'row written from the API answer',
    );
  },
);

Deno.test(
  'a body that claims a purchase cannot grant access RevenueCat does not confirm',
  async () => {
    const { rows, store } = memoryStore();
    // Valid auth (e.g. a leaked header), but RevenueCat says this user never bought anything.
    const rc = fakeRevenueCat({ [USER_A]: null });
    const res = await run({
      payload: event({ expiration_at_ms: Date.parse('2099-01-01T00:00:00Z') }),
      rc: rc.client,
      store,
    });
    assertEquals(res.status, 200, 'acknowledged');
    assertEquals(rows.get(`${USER_A}:carecircle_family`), rowA(false, null), 'stays inactive');

    // The body says the period runs until 2099, RevenueCat says it ended: RevenueCat wins.
    const rc2 = fakeRevenueCat({ [USER_A]: { expires: PAST } });
    await run({
      payload: event({ type: 'RENEWAL', expiration_at_ms: Date.parse('2099-01-01T00:00:00Z') }),
      rc: rc2.client,
      store,
    });
    assertEquals(
      rows.get(`${USER_A}:carecircle_family`),
      rowA(false, '2026-11-01T10:00:00.000Z'),
      'expired per API',
    );
  },
);

Deno.test('EXPIRATION: writes active = false', async () => {
  const { rows, store } = memoryStore([rowA(true, FUTURE)]);
  const rc = fakeRevenueCat({ [USER_A]: { expires: '2026-11-15T09:00:00Z' } });
  const res = await run({
    payload: event({ type: 'EXPIRATION', expiration_reason: 'UNSUBSCRIBE' }),
    rc: rc.client,
    store,
  });
  assertEquals(res.status, 200, '200');
  assertEquals(
    rows.get(`${USER_A}:carecircle_family`),
    rowA(false, '2026-11-15T09:00:00.000Z'),
    'expired',
  );
});

Deno.test(
  'a late EXPIRATION that arrives after a RENEWAL does not take away the renewed period',
  async () => {
    const { rows, store } = memoryStore([rowA(true, FUTURE)]);
    // RevenueCat already knows about the renewal.
    const rc = fakeRevenueCat({ [USER_A]: { expires: FUTURE } });
    await run({
      payload: event({
        type: 'EXPIRATION',
        expiration_at_ms: Date.parse('2026-11-14T10:00:00Z'),
        event_timestamp_ms: Date.parse('2026-11-14T10:00:01Z'),
      }),
      rc: rc.client,
      store,
    });
    assertEquals(
      rows.get(`${USER_A}:carecircle_family`),
      rowA(true, '2026-12-15T10:00:00.000Z'),
      'still active',
    );
  },
);

Deno.test(
  'CANCELLATION (auto-renew turned off) and BILLING_ISSUE keep access until the period or grace period ends',
  async () => {
    const { rows, store } = memoryStore([rowA(true, FUTURE)]);
    // Turned off auto-renew: the paid period still runs to FUTURE.
    let rc = fakeRevenueCat({ [USER_A]: { expires: FUTURE } });
    await run({
      payload: event({ type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE' }),
      rc: rc.client,
      store,
    });
    assertEquals(
      rows.get(`${USER_A}:carecircle_family`),
      rowA(true, '2026-12-15T10:00:00.000Z'),
      'cancel keeps access',
    );

    // Billing problem: the period ended an hour ago, but the store's grace period runs 6 more days.
    rc = fakeRevenueCat({
      [USER_A]: { expires: '2026-11-15T09:00:00Z', grace: '2026-11-21T09:00:00Z' },
    });
    await run({
      payload: event({
        type: 'BILLING_ISSUE',
        grace_period_expiration_at_ms: Date.parse('2026-11-21T09:00:00Z'),
      }),
      rc: rc.client,
      store,
    });
    assertEquals(
      rows.get(`${USER_A}:carecircle_family`),
      rowA(true, '2026-11-21T09:00:00.000Z'),
      'grace period keeps access and is the stored expiry',
    );
  },
);

Deno.test(
  'a refund (CANCELLATION with cancel_reason CUSTOMER_SUPPORT) removes access right away',
  async () => {
    const { rows, store } = memoryStore([rowA(true, FUTURE)]);
    const rc = fakeRevenueCat({
      [USER_A]: { expires: FUTURE, refundedAt: '2026-11-15T09:30:00Z' },
    });
    await run({
      payload: event({ type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT' }),
      rc: rc.client,
      store,
    });
    assertEquals(rows.get(`${USER_A}:carecircle_family`)?.active, false, 'refunded is inactive');
  },
);

Deno.test(
  'every other event type also syncs (renewal, product change, uncancel, transfer, new types)',
  async () => {
    for (const type of [
      'RENEWAL',
      'UNCANCELLATION',
      'PRODUCT_CHANGE',
      'NON_RENEWING_PURCHASE',
      'SUBSCRIPTION_EXTENDED',
      'SUBSCRIPTION_PAUSED',
      'TEMPORARY_ENTITLEMENT_GRANT',
      'REFUND_REVERSED',
      'PRICE_INCREASE_CONSENT_REQUIRED',
      'SOME_FUTURE_EVENT_TYPE',
    ]) {
      const { rows, store } = memoryStore([rowA(false, PAST)]);
      const rc = fakeRevenueCat({ [USER_A]: { expires: FUTURE } });
      const res = await run({
        payload: event({ type, entitlement_ids: null }),
        rc: rc.client,
        store,
      });
      assertEquals(res.status, 200, `${type} -> 200`);
      assertEquals(
        rows.get(`${USER_A}:carecircle_family`),
        rowA(true, '2026-12-15T10:00:00.000Z'),
        `${type} synced (entitlement_ids may be null)`,
      );
    }
  },
);

Deno.test('TRANSFER: the old owner loses access and the new owner gets it', async () => {
  const { rows, store } = memoryStore([rowA(true, FUTURE)]);
  const rc = fakeRevenueCat({ [USER_A]: null, [USER_B]: { expires: FUTURE } });
  // RevenueCat's TRANSFER samples have no app_user_id, only transferred_from / transferred_to.
  const res = await run({
    payload: {
      api_version: '1.0',
      event: {
        id: 'evt-transfer',
        type: 'TRANSFER',
        transferred_from: [USER_A],
        transferred_to: [USER_B],
        environment: 'PRODUCTION',
        event_timestamp_ms: NOW.getTime(),
      },
    },
    rc: rc.client,
    store,
  });
  assertEquals(res.status, 200, '200');
  assertEquals(rows.get(`${USER_A}:carecircle_family`), rowA(false, null), 'A revoked');
  assertEquals(
    rows.get(`${USER_B}:carecircle_family`),
    {
      user_id: USER_B,
      entitlement: 'carecircle_family',
      active: true,
      expires_at: '2026-12-15T10:00:00.000Z',
    },
    'B granted',
  );
});

Deno.test(
  'only Supabase user ids (UUIDs) are synced; anonymous RevenueCat ids are skipped',
  async () => {
    const { rows, store } = memoryStore();
    const rc = fakeRevenueCat({ [USER_C]: { expires: FUTURE } });
    const res = await run({
      payload: event({
        app_user_id: '$RCAnonymousID:8f0c2a1b3d4e5f60718293a4b5c6d7e8',
        original_app_user_id: '$RCAnonymousID:8f0c2a1b3d4e5f60718293a4b5c6d7e8',
        aliases: [
          '$RCAnonymousID:8f0c2a1b3d4e5f60718293a4b5c6d7e8',
          USER_C.toUpperCase(),
          'not-a-uuid',
          USER_C,
        ],
      }),
      rc: rc.client,
      store,
    });
    assertEquals(res.status, 200, '200');
    assertEquals(rc.calls, [USER_C], 'only the UUID is looked up, once, lower-cased');
    assertEquals([...rows.keys()], [`${USER_C}:carecircle_family`], 'only the UUID row');

    // Nothing but anonymous ids: acknowledge, write nothing.
    const empty = memoryStore();
    const rc2 = fakeRevenueCat({});
    const res2 = await run({
      payload: event({
        app_user_id: '$RCAnonymousID:abc',
        original_app_user_id: '$RCAnonymousID:abc',
        aliases: [],
      }),
      rc: rc2.client,
      store: empty.store,
    });
    assertEquals(res2.status, 200, 'acknowledged');
    assertEquals(empty.rows.size, 0, 'nothing written');
    assertEquals(rc2.calls, [], 'nothing looked up');
  },
);

Deno.test('TEST events are acknowledged without any lookup or write', async () => {
  const { rows, store } = memoryStore();
  const rc = fakeRevenueCat({ [USER_A]: { expires: FUTURE } });
  const res = await run({ payload: event({ type: 'TEST' }), rc: rc.client, store });
  assertEquals({ status: res.status, ok: res.ok }, { status: 200, ok: true }, '200');
  assertEquals(rc.calls, [], 'no lookup');
  assertEquals(rows.size, 0, 'no write');
});

Deno.test('a malformed body is a 400 and writes nothing', async () => {
  const { rows, store } = memoryStore();
  const rc = fakeRevenueCat({ [USER_A]: { expires: FUTURE } });
  for (const payload of [
    null,
    'x',
    42,
    {},
    { event: null },
    { event: { app_user_id: USER_A } },
    { event: { type: 7 } },
  ]) {
    const res = await run({ payload, rc: rc.client, store });
    assertEquals(
      { status: res.status, ok: res.ok },
      { status: 400, ok: false },
      `${JSON.stringify(payload)} -> 400`,
    );
  }
  assertEquals(rows.size, 0, 'no write');
  assertEquals(rc.calls, [], 'no lookup');
});

Deno.test(
  'fails with a non-200 (so RevenueCat retries) and keeps the old row when RevenueCat or the database fails',
  async () => {
    // RevenueCat API down: the paying user keeps the row they had.
    const a = memoryStore([rowA(true, FUTURE)]);
    const down = fakeRevenueCat({ [USER_A]: 'error' });
    const res = await run({ payload: event({ type: 'RENEWAL' }), rc: down.client, store: a.store });
    assert(res.status >= 500 && !res.ok, `RevenueCat error -> 5xx, got ${res.status}`);
    assertEquals(a.rows.get(`${USER_A}:carecircle_family`), rowA(true, FUTURE), 'row untouched');

    // RevenueCat answers with something that is not a subscriber: same.
    const weird: RevenueCatSubscriberClient = {
      async getSubscriber() {
        return { message: 'unexpected' };
      },
    };
    const res2 = await run({ payload: event({ type: 'RENEWAL' }), rc: weird, store: a.store });
    assert(res2.status >= 500 && !res2.ok, `odd API answer -> 5xx, got ${res2.status}`);
    assertEquals(a.rows.get(`${USER_A}:carecircle_family`), rowA(true, FUTURE), 'row untouched');

    // Database write fails.
    const b = memoryStore();
    b.failWrites();
    const ok = fakeRevenueCat({ [USER_A]: { expires: FUTURE } });
    const res3 = await run({ payload: event(), rc: ok.client, store: b.store });
    assert(res3.status >= 500 && !res3.ok, `write error -> 5xx, got ${res3.status}`);
  },
);

Deno.test(
  'sandbox purchases unlock only where allowSandbox is on (development), never in production',
  async () => {
    const prod = memoryStore();
    const rc = fakeRevenueCat({ [USER_A]: { expires: FUTURE, sandbox: true } });
    await run({
      payload: event({ environment: 'SANDBOX' }),
      rc: rc.client,
      store: prod.store,
      allowSandbox: false,
    });
    assertEquals(
      prod.rows.get(`${USER_A}:carecircle_family`)?.active,
      false,
      'production: sandbox ignored',
    );

    // The body saying PRODUCTION does not help: RevenueCat's is_sandbox decides.
    await run({
      payload: event({ environment: 'PRODUCTION' }),
      rc: rc.client,
      store: prod.store,
      allowSandbox: false,
    });
    assertEquals(
      prod.rows.get(`${USER_A}:carecircle_family`)?.active,
      false,
      'body cannot override is_sandbox',
    );

    const dev = memoryStore();
    await run({
      payload: event({ environment: 'SANDBOX' }),
      rc: rc.client,
      store: dev.store,
      allowSandbox: true,
    });
    assertEquals(
      dev.rows.get(`${USER_A}:carecircle_family`)?.active,
      true,
      'development: sandbox unlocks',
    );
  },
);

// ---- reading RevenueCat's answer ----

Deno.test('entitlementFromSubscriber reads carecircle_family from GET /v1/subscribers', () => {
  const opts = { entitlement: 'carecircle_family' as const, allowSandbox: false, now: NOW };
  const cases: Array<[string, unknown, { active: boolean; expires_at: string | null }]> = [
    [
      'active',
      subscriberResponse({ expires: FUTURE }),
      { active: true, expires_at: '2026-12-15T10:00:00.000Z' },
    ],
    [
      'expired',
      subscriberResponse({ expires: PAST }),
      { active: false, expires_at: '2026-11-01T10:00:00.000Z' },
    ],
    [
      'expires exactly now',
      subscriberResponse({ expires: '2026-11-15T10:00:00Z' }),
      { active: false, expires_at: '2026-11-15T10:00:00.000Z' },
    ],
    ['no entitlement', subscriberResponse(null), { active: false, expires_at: null }],
    [
      'other entitlement only',
      subscriberResponse({ entitlementId: 'other_pro' }),
      { active: false, expires_at: null },
    ],
    [
      'lifetime (expires_date null)',
      subscriberResponse({ expires: null }),
      { active: true, expires_at: null },
    ],
    [
      'grace period after a failed charge',
      subscriberResponse({ expires: PAST, grace: '2026-11-20T10:00:00Z' }),
      { active: true, expires_at: '2026-11-20T10:00:00.000Z' },
    ],
    [
      'grace period already over',
      subscriberResponse({ expires: '2026-11-01T10:00:00Z', grace: '2026-11-08T10:00:00Z' }),
      { active: false, expires_at: '2026-11-08T10:00:00.000Z' },
    ],
    [
      'refunded',
      subscriberResponse({ expires: FUTURE, refundedAt: '2026-11-15T09:30:00Z' }),
      { active: false, expires_at: '2026-11-15T09:30:00.000Z' },
    ],
    [
      'sandbox in production',
      subscriberResponse({ expires: FUTURE, sandbox: true }),
      { active: false, expires_at: '2026-12-15T10:00:00.000Z' },
    ],
  ];
  for (const [name, input, expected] of cases) {
    assertEquals(entitlementFromSubscriber(input, opts), expected, name);
  }
  assertEquals(
    entitlementFromSubscriber(subscriberResponse({ expires: FUTURE, sandbox: true }), {
      ...opts,
      allowSandbox: true,
    }),
    { active: true, expires_at: '2026-12-15T10:00:00.000Z' },
    'sandbox with allowSandbox',
  );

  // The entitlement points at a product with no matching purchase record: cannot check sandbox or
  // refund, so it does not unlock.
  const orphan = subscriberResponse({ expires: FUTURE });
  (orphan.subscriber as { subscriptions: Record<string, unknown> }).subscriptions = {};
  assertEquals(
    entitlementFromSubscriber(orphan, opts).active,
    false,
    'no purchase record -> inactive',
  );

  for (const bad of [null, {}, { subscriber: null }, { subscriber: { entitlements: 'x' } }]) {
    let threw = false;
    try {
      entitlementFromSubscriber(bad, opts);
    } catch {
      threw = true;
    }
    assert(threw, `malformed answer ${JSON.stringify(bad)} throws instead of returning inactive`);
  }
});

// ---- the deployed HTTP handler (env, RevenueCat call, database call) ----

type FetchCall = { url: string; method: string; headers: Headers; body: string | null };

function fetchSpy(rcAnswer: unknown, opts: { rcStatus?: number; dbStatus?: number } = {}) {
  const calls: FetchCall[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: (init?.body as string) ?? null,
    });
    if (url.startsWith('https://api.revenuecat.com/')) {
      return new Response(JSON.stringify(rcAnswer), { status: opts.rcStatus ?? 200 });
    }
    return new Response(null, { status: opts.dbStatus ?? 201 });
  };
  return { impl, calls };
}

const ENV: Record<string, string> = {
  REVENUECAT_WEBHOOK_SECRET: WEBHOOK_SECRET,
  REVENUECAT_SECRET_API_KEY: RC_API_KEY,
  REVENUECAT_ALLOW_SANDBOX: 'false',
  SUPABASE_URL: 'http://supabase.local',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests',
};

const post = (body: unknown, auth = `Bearer ${WEBHOOK_SECRET}`, method = 'POST') =>
  new Request('http://localhost/functions/v1/revenuecat-webhook', {
    method,
    headers: { 'content-type': 'application/json', authorization: auth },
    body: method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

Deno.test(
  'handler: asks RevenueCat with the secret key and upserts the row with the service role',
  async () => {
    const spy = fetchSpy(subscriberResponse({ expires: FUTURE }));
    const handler = createRevenueCatWebhookHandler({
      getEnv: (k) => ENV[k],
      fetchImpl: spy.impl,
      now: () => NOW,
    });
    const res = await handler(post(event()));
    assertEquals(res.status, 200, '200');

    const rcCall = spy.calls.find((c) => c.url.startsWith('https://api.revenuecat.com/'));
    assert(rcCall !== undefined, 'RevenueCat was called');
    assertEquals(
      rcCall?.url,
      `https://api.revenuecat.com/v1/subscribers/${USER_A}`,
      'v1 subscribers URL',
    );
    assertEquals(rcCall?.method, 'GET', 'GET');
    assertEquals(rcCall?.headers.get('authorization'), `Bearer ${RC_API_KEY}`, 'secret API key');
    assertEquals(
      rcCall?.headers.get('x-platform'),
      null,
      'no X-Platform (it would change last_seen)',
    );

    const dbCall = spy.calls.find((c) =>
      c.url.startsWith('http://supabase.local/rest/v1/entitlements'),
    );
    assert(dbCall !== undefined, 'entitlements upsert was sent');
    assertEquals(dbCall?.method, 'POST', 'POST');
    assert(
      dbCall?.url.includes('on_conflict=user_id,entitlement') === true,
      'upsert on the primary key',
    );
    assert(
      (dbCall?.headers.get('prefer') ?? '').includes('resolution=merge-duplicates'),
      'merge-duplicates so a second event updates the row',
    );
    assertEquals(
      dbCall?.headers.get('authorization'),
      'Bearer service-role-key-for-tests',
      'service role',
    );
    assertEquals(
      JSON.parse(dbCall?.body ?? 'null'),
      {
        user_id: USER_A,
        entitlement: 'carecircle_family',
        active: true,
        expires_at: '2026-12-15T10:00:00.000Z',
      },
      'row body',
    );
    const text = await res.text();
    assert(
      !text.includes(RC_API_KEY) && !text.includes(WEBHOOK_SECRET),
      'response leaks no secret',
    );
  },
);

Deno.test(
  'handler: wrong method, bad JSON, bad auth, missing settings and upstream errors',
  async () => {
    const make = (env: Record<string, string>, rcStatus = 200, dbStatus = 201) => {
      const spy = fetchSpy(subscriberResponse({ expires: FUTURE }), { rcStatus, dbStatus });
      return {
        spy,
        handler: createRevenueCatWebhookHandler({
          getEnv: (k) => env[k],
          fetchImpl: spy.impl,
          now: () => NOW,
        }),
      };
    };

    let t = make(ENV);
    assertEquals((await t.handler(post(null, undefined, 'GET'))).status, 405, 'GET -> 405');
    assertEquals((await t.handler(post('{not json'))).status, 400, 'bad JSON -> 400');
    assertEquals((await t.handler(post(event(), 'Bearer nope'))).status, 401, 'bad auth -> 401');
    assertEquals(t.spy.calls.length, 0, 'no outbound call for any of these');

    for (const missing of [
      'REVENUECAT_WEBHOOK_SECRET',
      'REVENUECAT_SECRET_API_KEY',
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
    ]) {
      const env = { ...ENV };
      delete env[missing];
      t = make(env);
      const res = await t.handler(post(event()));
      assertEquals(res.status, 500, `missing ${missing} -> 500`);
      assert(
        !t.spy.calls.some((c) => c.url.includes('/rest/v1/entitlements')),
        `missing ${missing}: nothing written`,
      );
    }

    t = make(ENV, 503);
    assert((await t.handler(post(event()))).status >= 500, 'RevenueCat 503 -> 5xx');
    assert(!t.spy.calls.some((c) => c.url.includes('/rest/v1/entitlements')), 'nothing written');

    t = make(ENV, 200, 500);
    assert((await t.handler(post(event()))).status >= 500, 'database 500 -> 5xx');

    // Sandbox is off unless the setting is exactly "true".
    for (const value of [undefined, 'false', 'TRUE', '1', 'yes']) {
      const env = { ...ENV };
      if (value === undefined) delete env.REVENUECAT_ALLOW_SANDBOX;
      else env.REVENUECAT_ALLOW_SANDBOX = value;
      const spy = fetchSpy(subscriberResponse({ expires: FUTURE, sandbox: true }));
      const h = createRevenueCatWebhookHandler({
        getEnv: (k) => env[k],
        fetchImpl: spy.impl,
        now: () => NOW,
      });
      await h(post(event({ environment: 'SANDBOX' })));
      const db = spy.calls.find((c) => c.url.includes('/rest/v1/entitlements'));
      assertEquals(
        JSON.parse(db?.body ?? '{}').active,
        false,
        `REVENUECAT_ALLOW_SANDBOX=${value} -> sandbox ignored`,
      );
    }
  },
);

Deno.test(
  'config.toml turns off Supabase JWT checks for this function (RevenueCat sends no Supabase JWT)',
  async () => {
    const toml = await Deno.readTextFile(new URL('../../config.toml', import.meta.url));
    const section = toml
      .split(/\n(?=\[)/)
      .find((s) => s.trim().startsWith('[functions.revenuecat-webhook]'));
    assert(section !== undefined, '[functions.revenuecat-webhook] section exists');
    assert(/\bverify_jwt\s*=\s*false\b/.test(section ?? ''), 'verify_jwt = false');
  },
);
