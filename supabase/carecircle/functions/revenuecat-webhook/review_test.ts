// Added in review (PR #21): lifetime purchases and what the webhook writes to the logs.
import { createRevenueCatWebhookHandler, entitlementFromSubscriber } from './handler.ts';

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${msg ?? 'assertEquals'}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`,
    );
  }
}

const NOW = new Date('2026-11-15T10:00:00.000Z');
const USER_A = '11111111-1111-4111-8111-111111111111';
const WEBHOOK_SECRET = 'rc-webhook-secret-0123456789abcdef0123456789abcdef';
const RC_API_KEY = 'sk_test_revenuecat_secret_api_key_123456';
const SERVICE_KEY = 'service-role-key-for-tests';

function lifetimeAnswer(extra: Record<string, unknown> = {}) {
  return {
    subscriber: {
      entitlements: {
        carecircle_family: {
          expires_date: null,
          grace_period_expires_date: null,
          product_identifier: 'carecircle_family_lifetime',
          purchase_date: '2026-11-01T10:00:00Z',
        },
      },
      subscriptions: {},
      non_subscriptions: {
        carecircle_family_lifetime: [
          { id: 'old', purchase_date: '2026-10-01T10:00:00Z', is_sandbox: false, ...extra },
          { id: 'new', purchase_date: '2026-11-01T10:00:00Z', is_sandbox: false, ...extra },
        ],
      },
    },
  };
}

Deno.test('a lifetime (non-subscription) purchase is active with no expiry', () => {
  assertEquals(entitlementFromSubscriber(lifetimeAnswer(), { now: NOW }), {
    active: true,
    expires_at: null,
  });
});

Deno.test('a refunded lifetime purchase is inactive', () => {
  assertEquals(
    entitlementFromSubscriber(lifetimeAnswer({ refunded_at: '2026-11-10T10:00:00Z' }), {
      now: NOW,
    }),
    { active: false, expires_at: '2026-11-10T10:00:00.000Z' },
  );
});

Deno.test('a sandbox lifetime purchase is inactive unless sandbox is allowed', () => {
  const answer = lifetimeAnswer({ is_sandbox: true });
  assertEquals(entitlementFromSubscriber(answer, { now: NOW }).active, false);
  assertEquals(entitlementFromSubscriber(answer, { now: NOW, allowSandbox: true }).active, true);
});

Deno.test('the webhook logs only event id, type, status and error code', async () => {
  const logged: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  try {
    const env: Record<string, string> = {
      REVENUECAT_WEBHOOK_SECRET: WEBHOOK_SECRET,
      REVENUECAT_SECRET_API_KEY: RC_API_KEY,
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    };
    const handler = createRevenueCatWebhookHandler({
      getEnv: (k) => env[k],
      now: () => NOW,
      fetchImpl: (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.startsWith('https://api.revenuecat.com/')) {
          return Promise.resolve(Response.json(lifetimeAnswer()));
        }
        return Promise.resolve(new Response(null, { status: 201 }));
      },
    });
    const res = await handler(
      new Request('https://example.supabase.co/functions/v1/revenuecat-webhook', {
        method: 'POST',
        headers: { authorization: `Bearer ${WEBHOOK_SECRET}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          event: {
            id: 'CDD3E1A1-0000-4000-8000-000000000001',
            type: 'NON_RENEWING_PURCHASE',
            app_user_id: USER_A,
            subscriber_attributes: { $email: { value: 'mum@example.com' } },
          },
        }),
      }),
    );
    assertEquals(res.status, 200);
    assertEquals(logged.length, 1, 'one log line');
    const line = logged[0];
    for (const secret of [USER_A, WEBHOOK_SECRET, RC_API_KEY, SERVICE_KEY, 'example.com']) {
      if (line.includes(secret)) throw new Error(`log line leaks ${secret}: ${line}`);
    }
    assertEquals(JSON.parse(line), {
      fn: 'revenuecat-webhook',
      event_id: 'CDD3E1A1-0000-4000-8000-000000000001',
      event_type: 'NON_RENEWING_PURCHASE',
      status: 200,
      error_code: null,
    });
  } finally {
    console.log = originalLog;
  }
});
