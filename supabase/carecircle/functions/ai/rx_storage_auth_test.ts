// CC-4a pre-work [safety 1/2]: Gateway authorization and Storage read tests for `carecircle.extractPrescription`.
// Rules (decided 2026-11-15):
// - `imagePath` must match `<circle_id>/<uuid>.jpg`.
// - Before reading the file from Storage or calling any AI provider, `carecircle.extractPrescription`
//   checks that the authenticated caller is `owner` or `helper` of `<circle_id>` in `imagePath`.
// - A `viewer` of `<circle_id>`, an `owner` of another family's circle, or a non-member is refused,
//   and the Storage object is NEVER read.

import { createAiGatewayHandler, type AiCallLogRow, type AiGatewayDeps } from './handler.ts';
import { FAKE_FIXTURES, type AiProvider } from './routes.ts';

const CIRCLE_A = 'cc4ac001-0000-4000-8000-000000000001';
const CIRCLE_B = 'cc4ac002-0000-4000-8000-000000000002';
const PHOTO_UUID = '11111111-1111-4111-8111-111111111111';
const VALID_IMAGE_PATH = `${CIRCLE_A}/${PHOTO_UUID}.jpg`;

const OWNER_A = 'cc4a0001-0000-4000-8000-000000000001';
const HELPER_A = 'cc4a0002-0000-4000-8000-000000000002';
const VIEWER_A = 'cc4a0003-0000-4000-8000-000000000003';
const OWNER_B = 'cc4a0004-0000-4000-8000-000000000004';
const REQ_ID = '22222222-2222-4222-8222-222222222222';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
};

interface RxGatewayDeps extends AiGatewayDeps {
  checkPrescriptionCircleAccess?: (opts: { userId: string; circleId: string }) => Promise<boolean>;
  readPrescriptionPhoto?: (opts: {
    imagePath: string;
  }) => Promise<{ bytes: Uint8Array; contentType: string } | null>;
}

Deno.test(
  'extractPrescription refuses viewer and another family owner BEFORE reading from Storage or calling provider',
  async () => {
    const events: string[] = [];
    const rolesByCircleAndUser = new Map<string, 'owner' | 'helper' | 'viewer'>([
      [`${CIRCLE_A}:${OWNER_A}`, 'owner'],
      [`${CIRCLE_A}:${HELPER_A}`, 'helper'],
      [`${CIRCLE_A}:${VIEWER_A}`, 'viewer'],
      [`${CIRCLE_B}:${OWNER_B}`, 'owner'],
    ]);

    const makeCall = async (callerUserId: string, imagePath = VALID_IMAGE_PATH) => {
      events.length = 0;
      const aiCalls: AiCallLogRow[] = [];
      const stubProvider: AiProvider = {
        generate: async (req) => {
          events.push('provider:generate');
          return {
            output: FAKE_FIXTURES[req.task],
            inputTokens: 40,
            outputTokens: 20,
          };
        },
      };

      const deps: RxGatewayDeps = {
        verifyJwt: async () => ({ userId: callerUserId }),
        countRecentCalls: async () => 0,
        logCall: async (row) => void aiCalls.push(row),
        providers: {
          fake: stubProvider,
          gemini: stubProvider,
          anthropic: stubProvider,
        },
        checkPrescriptionCircleAccess: async ({ userId, circleId }) => {
          events.push(`access:${circleId}:${userId}`);
          const role = rolesByCircleAndUser.get(`${circleId}:${userId}`);
          return role === 'owner' || role === 'helper';
        },
        readPrescriptionPhoto: async ({ imagePath: path }) => {
          events.push(`storage:read:${path}`);
          return {
            bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
            contentType: 'image/jpeg',
          };
        },
      };

      const handler = createAiGatewayHandler(deps);
      const res = await handler(
        new Request('http://localhost/functions/v1/ai', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer valid-jwt',
          },
          body: JSON.stringify({
            task: 'carecircle.extractPrescription',
            input: { imagePath },
            requestId: REQ_ID,
          }),
        }),
      );
      const body = (await res.json()) as {
        ok: boolean;
        error?: { code: string; retryable: boolean };
      };
      return { res, body, events: [...events], aiCalls };
    };

    // 1. Viewer of Circle A is refused BEFORE Storage read
    const viewerResult = await makeCall(VIEWER_A);
    assert(viewerResult.body.ok === false, 'viewer must be refused by extractPrescription');
    assert(
      !viewerResult.events.some((e) => e.startsWith('storage:read:')) &&
        !viewerResult.events.includes('provider:generate'),
      `viewer must be refused before reading Storage or calling provider, got events: ${viewerResult.events.join(', ')}`,
    );

    // 2. Owner of Circle B (another family) is refused for Circle A's imagePath BEFORE Storage read
    const otherOwnerResult = await makeCall(OWNER_B);
    assert(
      otherOwnerResult.body.ok === false,
      'another family owner must be refused by extractPrescription',
    );
    assert(
      !otherOwnerResult.events.some((e) => e.startsWith('storage:read:')) &&
        !otherOwnerResult.events.includes('provider:generate'),
      `other family owner must be refused before reading Storage or calling provider, got events: ${otherOwnerResult.events.join(', ')}`,
    );

    // 3. Malformed imagePath (not `<circle_id>/<uuid>.jpg`) is refused BEFORE Storage read
    for (const badPath of [
      'rx.jpg',
      `${CIRCLE_A}/not-a-uuid.jpg`,
      `${CIRCLE_A}/${PHOTO_UUID}.png`,
      `${CIRCLE_A}/nested/${PHOTO_UUID}.jpg`,
      `../${CIRCLE_A}/${PHOTO_UUID}.jpg`,
    ]) {
      const badPathResult = await makeCall(OWNER_A, badPath);
      assert(
        badPathResult.body.ok === false && badPathResult.body.error?.code === 'INPUT_INVALID',
        `expected INPUT_INVALID for malformed imagePath ${badPath}, got ${JSON.stringify(badPathResult.body)}`,
      );
      assert(
        !badPathResult.events.some((e) => e.startsWith('storage:read:')) &&
          !badPathResult.events.includes('provider:generate'),
        `malformed imagePath ${badPath} must not read Storage or call provider`,
      );
    }

    // 4. Owner A and Helper A succeed, checking circle access FIRST and reading Storage SECOND
    for (const allowedUser of [OWNER_A, HELPER_A]) {
      const okResult = await makeCall(allowedUser);
      assert(
        okResult.body.ok === true,
        `expected owner/helper (${allowedUser}) to succeed, got ${JSON.stringify(okResult.body)}`,
      );
      assert(
        okResult.events[0] === `access:${CIRCLE_A}:${allowedUser}` &&
          okResult.events[1] === `storage:read:${VALID_IMAGE_PATH}` &&
          okResult.events[2] === 'provider:generate',
        `expected access check -> storage read -> provider generate, got ${okResult.events.join(' -> ')}`,
      );
    }
  },
);

Deno.test(
  'extractPrescription default Supabase adapters verify owner/helper in circle_members before downloading from prescription-photos bucket',
  async () => {
    const seenUrls: string[] = [];

    const mockFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      seenUrls.push(url);
      // Circle membership query for VIEWER_A returns empty array (not owner/helper)
      if (url.includes('/rest/v1/circle_members')) {
        return Response.json([]);
      }
      if (url.includes('/storage/v1/object/')) {
        throw new Error('Storage must not be called when circle_members check returns no row');
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    const handler = createAiGatewayHandler({
      verifyJwt: async () => ({ userId: VIEWER_A }),
      countRecentCalls: async () => 0,
      logCall: async () => {},
      fetchImpl: mockFetch,
      getEnv: (key) => {
        if (key === 'SUPABASE_URL') return 'https://example.supabase.co';
        if (key === 'SUPABASE_SERVICE_ROLE_KEY') return 'service-role-key';
        if (key === 'GEMINI_API_KEY') return 'gemini-key';
        return undefined;
      },
    });

    const res = await handler(
      new Request('http://localhost/functions/v1/ai', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer viewer-jwt',
        },
        body: JSON.stringify({
          task: 'carecircle.extractPrescription',
          input: { imagePath: VALID_IMAGE_PATH },
          requestId: REQ_ID,
        }),
      }),
    );

    const body = (await res.json()) as { ok: boolean; error?: { code: string } };
    assert(body.ok === false, 'viewer must be refused by default circle_members check');
    assert(
      seenUrls.some((u) => u.includes('/rest/v1/circle_members')) &&
        !seenUrls.some((u) => u.includes('/storage/v1/object/')),
      `expected circle_members query and zero storage queries, got: ${seenUrls.join(', ')}`,
    );
  },
);
