// CC-8 [safety 1/2]: Server-side Family plan limit tests for Edge Functions (`summarizeVisit` and `export-log`).
//
// Tests that each free-plan limit is refused by the server even when called directly by a modified app
// with forged `entitlements` fields in the request body, and that an expired entitlement
// (`expires_at` in the past, `active: true`) counts as free.

import { createExportLogHandler } from '../export-log/handler.ts';
import { createAiGatewayHandler } from './handler.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

const CIRCLE_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const HELPER_ID = '33333333-3333-4333-8333-333333333333';
const VIEWER_ID = '44444444-4444-4444-8444-444444444444';
const REQ_ID = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-11-17T12:00:00.000Z');

function createVisitGatewayForPlanTest(opts: {
  entitlementRow: {
    user_id: string;
    entitlement: 'carecircle_family';
    active: boolean;
    expires_at: string | null;
  } | null;
}) {
  let providerCalls = 0;

  const handler = createAiGatewayHandler({
    verifyJwt: async (token) => {
      if (token === 'jwt-owner') return { userId: OWNER_ID };
      if (token === 'jwt-helper') return { userId: HELPER_ID };
      if (token === 'jwt-viewer') return { userId: VIEWER_ID };
      return null;
    },
    countRecentCalls: async () => 0,
    logCall: async () => undefined,
    checkPrescriptionCircleAccess: async ({ userId, circleId }) => {
      if (circleId !== CIRCLE_ID) return false;
      return userId === OWNER_ID || userId === HELPER_ID;
    },
    checkCircleMedicationIds: async () => true,
    entitlementStore: {
      async getCircleOwnerUserId(circleId) {
        return { data: circleId === CIRCLE_ID ? OWNER_ID : null, error: null };
      },
      async getEntitlement(userId, entitlement) {
        if (userId === OWNER_ID && entitlement === 'carecircle_family') {
          return { data: opts.entitlementRow, error: null };
        }
        return { data: null, error: null };
      },
    },
    providers: {
      fake: {
        async generate() {
          providerCalls += 1;
          return {
            output: {
              summary: 'Summary text.',
              followUps: [],
              medChanges: [],
              questionsToAsk: [],
            },
            inputTokens: 10,
            outputTokens: 10,
          };
        },
      },
      anthropic: {
        async generate() {
          providerCalls += 1;
          return {
            output: {
              summary: 'Summary text.',
              followUps: [],
              medChanges: [],
              questionsToAsk: [],
            },
            inputTokens: 10,
            outputTokens: 10,
          };
        },
      },
    },
    now: () => NOW.getTime(),
  });

  return { handler, getProviderCalls: () => providerCalls };
}

function makeSummarizeVisitRequest(token: string, extraBody: Record<string, unknown> = {}) {
  return new Request('https://example.test/functions/v1/ai', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      task: 'carecircle.summarizeVisit',
      requestId: REQ_ID,
      input: {
        circleId: CIRCLE_ID,
        text: 'Doctor reviewed blood pressure and medications.',
        knownMeds: [],
        ...(extraBody.inputExtras as Record<string, unknown> | undefined),
      },
      ...extraBody,
    }),
  });
}

Deno.test(
  'CC-8 summarizeVisit: free circle owner, helper, and viewer are refused with QUOTA_EXCEEDED',
  async () => {
    const { handler, getProviderCalls } = createVisitGatewayForPlanTest({
      entitlementRow: null,
    });

    for (const [label, token, expectedCode] of [
      ['owner', 'jwt-owner', 'QUOTA_EXCEEDED'],
      ['helper', 'jwt-helper', 'QUOTA_EXCEEDED'],
      ['viewer', 'jwt-viewer', 'INPUT_INVALID'],
    ] as const) {
      const res = await handler(makeSummarizeVisitRequest(token));
      const body = (await res.json()) as {
        ok: boolean;
        error?: { code?: string };
      };
      assert(body.ok === false, `expected ok: false for free circle ${label}`);
      assert(
        body.error?.code === expectedCode,
        `expected ${expectedCode} for free circle ${label}, got ${JSON.stringify(body)}`,
      );
    }

    assert(getProviderCalls() === 0, 'AI provider must never be called on a free circle');
  },
);

Deno.test(
  'CC-8 summarizeVisit: forged entitlements field in request body is ignored and refused with QUOTA_EXCEEDED',
  async () => {
    const { handler, getProviderCalls } = createVisitGatewayForPlanTest({
      entitlementRow: null,
    });

    const res = await handler(
      makeSummarizeVisitRequest('jwt-owner', {
        entitlements: {
          user_id: OWNER_ID,
          entitlement: 'carecircle_family',
          active: true,
          expires_at: '2099-01-01T00:00:00.000Z',
        },
        plan: 'carecircle_family',
        isFamilyPlan: true,
      }),
    );

    const body = (await res.json()) as {
      ok: boolean;
      error?: { code?: string };
    };
    assert(body.ok === false, 'expected ok: false with forged entitlements');
    assert(
      body.error?.code === 'QUOTA_EXCEEDED',
      `expected QUOTA_EXCEEDED with forged body field, got ${JSON.stringify(body)}`,
    );
    assert(getProviderCalls() === 0, 'AI provider must not be called with forged entitlements');
  },
);

Deno.test(
  'CC-8 summarizeVisit: expired entitlement (expires_at in the past, active: true) counts as free and returns QUOTA_EXCEEDED',
  async () => {
    const { handler, getProviderCalls } = createVisitGatewayForPlanTest({
      entitlementRow: {
        user_id: OWNER_ID,
        entitlement: 'carecircle_family',
        active: true,
        expires_at: '2026-11-17T11:59:59.000Z', // 1 second before NOW
      },
    });

    const res = await handler(makeSummarizeVisitRequest('jwt-owner'));
    const body = (await res.json()) as {
      ok: boolean;
      error?: { code?: string };
    };
    assert(body.ok === false, 'expected ok: false when entitlement is expired');
    assert(
      body.error?.code === 'QUOTA_EXCEEDED',
      `expected QUOTA_EXCEEDED for expired entitlement, got ${JSON.stringify(body)}`,
    );
    assert(getProviderCalls() === 0, 'AI provider must not be called when entitlement is expired');
  },
);

Deno.test(
  'CC-8 export-log: free circle, forged body field, and expired entitlement are all refused with 402 QUOTA_EXCEEDED before reading data',
  async () => {
    for (const scenario of [
      { name: 'free circle (no entitlement row)', entitlementRow: null },
      {
        name: 'expired entitlement (active: true, expires_at in the past)',
        entitlementRow: {
          user_id: OWNER_ID,
          entitlement: 'carecircle_family' as const,
          active: true,
          expires_at: '2026-11-17T00:00:00.000Z',
        },
      },
    ]) {
      let dataReadCalls = 0;

      const handler = createExportLogHandler({
        verifyJwt: async () => ({ userId: OWNER_ID }),
        store: {
          async isCircleMember() {
            return true;
          },
          async getCircle() {
            dataReadCalls += 1;
            return null;
          },
          async listLogEntries() {
            dataReadCalls += 1;
            return [];
          },
          async getDisplayNames() {
            dataReadCalls += 1;
            return {};
          },
        },
        storage: {
          async uploadPdf() {
            throw new Error('must not upload on free/expired plan');
          },
          async createSignedUrl() {
            throw new Error('must not sign URL on free/expired plan');
          },
        },
        entitlementStore: {
          async getCircleOwnerUserId() {
            return { data: OWNER_ID, error: null };
          },
          async getEntitlement() {
            return { data: scenario.entitlementRow, error: null };
          },
        },
        now: () => NOW,
      });

      const res = await handler(
        new Request('https://example.test/functions/v1/export-log', {
          method: 'POST',
          headers: {
            authorization: 'Bearer jwt-owner',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            circleId: CIRCLE_ID,
            from: '2026-11-01',
            to: '2026-11-17',
            // Forged entitlement fields sent by a modified app
            entitlements: {
              user_id: OWNER_ID,
              entitlement: 'carecircle_family',
              active: true,
              expires_at: '2099-01-01T00:00:00.000Z',
            },
            plan: 'carecircle_family',
            isFamilyPlan: true,
          }),
        }),
      );

      assert(res.status === 402, `expected 402 for ${scenario.name}, got ${res.status}`);
      const payload = (await res.json()) as {
        ok: boolean;
        code?: string;
        error?: { code?: string };
      };
      assert(payload.ok === false, `expected ok: false for ${scenario.name}`);
      assert(
        payload.code === 'QUOTA_EXCEEDED' || payload.error?.code === 'QUOTA_EXCEEDED',
        `expected QUOTA_EXCEEDED for ${scenario.name}, got ${JSON.stringify(payload)}`,
      );
      assert(
        dataReadCalls === 0,
        `must not read circle or log data on ${scenario.name}, got ${dataReadCalls} calls`,
      );
    }
  },
);
