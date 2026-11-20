// CC-4a pre-work [safety 1/2]: Gateway authorization and Storage read tests for `carecircle.extractPrescription`.
// Rules (decided 2026-11-15):
// - `imagePath` must match `<circle_id>/<uuid>.jpg` (lowercase UUIDs, nothing else).
// - Before reading the file from Storage or calling any AI provider, `carecircle.extractPrescription`
//   checks that the authenticated caller is `owner` or `helper` of `<circle_id>` in `imagePath`.
// - A `viewer` of `<circle_id>`, an `owner` of another family's circle, a person who is helper of another
//   circle but only viewer of this one, or a non-member is refused, and the Storage object is NEVER read.
// - Refusals use the existing C2 error code `INPUT_INVALID` with `retryable: false` (no new code).
// - The photo bytes reach the provider as `req.image = { bytes, mimeType: 'image/jpeg' }` on
//   `AiProviderRequest`; the default Gemini provider sends them as an inline JPEG part.
// - A missing photo, a non-JPEG file or a file over 2 MB is `INPUT_INVALID` and the provider is not called.
// - If the membership check cannot run (database down), fail closed: `PROVIDER_ERROR`, retryable, no read.

import { createAiGatewayHandler, type AiCallLogRow, type AiGatewayDeps } from './handler.ts';
import { FAKE_FIXTURES, type AiProvider, type AiProviderRequest } from './routes.ts';

const CIRCLE_A = 'cc4ac001-0000-4000-8000-000000000001';
const CIRCLE_B = 'cc4ac002-0000-4000-8000-000000000002';
const PHOTO_UUID = '11111111-1111-4111-8111-111111111111';
const VALID_IMAGE_PATH = `${CIRCLE_A}/${PHOTO_UUID}.jpg`;

const OWNER_A = 'cc4a0001-0000-4000-8000-000000000001';
const HELPER_A = 'cc4a0002-0000-4000-8000-000000000002';
const VIEWER_A = 'cc4a0003-0000-4000-8000-000000000003';
const OWNER_B = 'cc4a0004-0000-4000-8000-000000000004';
const OUTSIDER = 'cc4a0005-0000-4000-8000-000000000005';
// Helper in Circle B, only viewer in Circle A.
const DUAL = 'cc4a0006-0000-4000-8000-000000000006';
const REQ_ID = '22222222-2222-4222-8222-222222222222';

const JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9,
]);

const MEMBERS: Array<{ circle_id: string; user_id: string; role: 'owner' | 'helper' | 'viewer' }> =
  [
    { circle_id: CIRCLE_A, user_id: OWNER_A, role: 'owner' },
    { circle_id: CIRCLE_A, user_id: HELPER_A, role: 'helper' },
    { circle_id: CIRCLE_A, user_id: VIEWER_A, role: 'viewer' },
    { circle_id: CIRCLE_A, user_id: DUAL, role: 'viewer' },
    { circle_id: CIRCLE_B, user_id: OWNER_B, role: 'owner' },
    { circle_id: CIRCLE_B, user_id: DUAL, role: 'helper' },
  ];

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
};

type ProviderRequestWithImage = AiProviderRequest & {
  image?: { bytes: Uint8Array; mimeType: string };
};

interface RxGatewayDeps extends AiGatewayDeps {
  checkPrescriptionCircleAccess?: (opts: { userId: string; circleId: string }) => Promise<boolean>;
  readPrescriptionPhoto?: (opts: {
    imagePath: string;
  }) => Promise<{ bytes: Uint8Array; contentType: string } | null>;
}

type GatewayBody = {
  ok: boolean;
  output?: unknown;
  error?: { code: string; retryable: boolean };
};

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array): boolean =>
  !!a && a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

const callGateway = async (
  deps: RxGatewayDeps,
  task: 'carecircle.extractPrescription' | 'carecircle.summarizeVisit',
  input: Record<string, unknown>,
) => {
  const handler = createAiGatewayHandler(deps);
  const res = await handler(
    new Request('http://localhost/functions/v1/ai', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer valid-jwt' },
      body: JSON.stringify({ task, input, requestId: REQ_ID }),
    }),
  );
  return { res, body: (await res.json()) as GatewayBody };
};

type CallOptions = {
  imagePath?: string;
  photo?: { bytes: Uint8Array; contentType: string } | null;
  accessThrows?: boolean;
};

const makeInjectedCall = async (callerUserId: string, opts: CallOptions = {}) => {
  const events: string[] = [];
  const providerRequests: ProviderRequestWithImage[] = [];
  const aiCalls: AiCallLogRow[] = [];
  const stubProvider: AiProvider = {
    generate: async (req) => {
      events.push('provider:generate');
      providerRequests.push(req as ProviderRequestWithImage);
      return { output: FAKE_FIXTURES[req.task], inputTokens: 40, outputTokens: 20 };
    },
  };
  const photo =
    opts.photo === undefined ? { bytes: JPEG_BYTES, contentType: 'image/jpeg' } : opts.photo;
  const deps: RxGatewayDeps = {
    verifyJwt: async () => ({ userId: callerUserId }),
    countRecentCalls: async () => 0,
    logCall: async (row) => void aiCalls.push(row),
    providers: { fake: stubProvider, gemini: stubProvider, anthropic: stubProvider },
    checkPrescriptionCircleAccess: async ({ userId, circleId }) => {
      events.push(`access:${circleId}:${userId}`);
      if (opts.accessThrows) throw new Error('database unavailable');
      const row = MEMBERS.find((m) => m.circle_id === circleId && m.user_id === userId);
      return row?.role === 'owner' || row?.role === 'helper';
    },
    readPrescriptionPhoto: async ({ imagePath: path }) => {
      events.push(`storage:read:${path}`);
      return photo;
    },
  };
  const { res, body } = await callGateway(deps, 'carecircle.extractPrescription', {
    imagePath: opts.imagePath ?? VALID_IMAGE_PATH,
  });
  return { res, body, events, providerRequests, aiCalls };
};

const readOrProvider = (events: string[]) =>
  events.some((e) => e.startsWith('storage:read:')) || events.includes('provider:generate');

Deno.test(
  'extractPrescription refuses viewer, other family, dual-role and outsider BEFORE reading from Storage or calling provider',
  async () => {
    for (const [label, user] of [
      ['viewer of Circle A', VIEWER_A],
      ['owner of Circle B', OWNER_B],
      ['helper of Circle B who is only viewer of Circle A', DUAL],
      ['non-member', OUTSIDER],
    ] as const) {
      const r = await makeInjectedCall(user);
      assert(r.body.ok === false, `${label} must be refused`);
      assert(
        r.body.error?.code === 'INPUT_INVALID' && r.body.error.retryable === false,
        `${label}: expected INPUT_INVALID, not retryable, got ${JSON.stringify(r.body)}`,
      );
      assert(
        r.events.includes(`access:${CIRCLE_A}:${user}`),
        `${label}: access must be checked for the circle in imagePath, got ${r.events.join(', ')}`,
      );
      assert(
        !readOrProvider(r.events),
        `${label} must be refused before reading Storage or calling provider, got events: ${r.events.join(', ')}`,
      );
    }
  },
);

Deno.test(
  'extractPrescription refuses malformed imagePath BEFORE any access check, Storage read or provider call',
  async () => {
    for (const badPath of [
      'rx.jpg',
      `circles/${CIRCLE_A}/rx/${PHOTO_UUID}.jpg`,
      `${CIRCLE_A}/not-a-uuid.jpg`,
      `${CIRCLE_A}/${PHOTO_UUID}.png`,
      `${CIRCLE_A}/${PHOTO_UUID}.jpg.png`,
      `${CIRCLE_A}/${PHOTO_UUID}.JPG`,
      `${CIRCLE_A}/nested/${PHOTO_UUID}.jpg`,
      `${CIRCLE_A}/${PHOTO_UUID}.jpg/x`,
      `../${CIRCLE_A}/${PHOTO_UUID}.jpg`,
      `/${CIRCLE_A}/${PHOTO_UUID}.jpg`,
      `family-a/${PHOTO_UUID}.jpg`,
      `${CIRCLE_A.toUpperCase()}/${PHOTO_UUID}.jpg`,
      ` ${VALID_IMAGE_PATH}`,
    ]) {
      const r = await makeInjectedCall(OWNER_A, { imagePath: badPath });
      assert(
        r.body.ok === false && r.body.error?.code === 'INPUT_INVALID',
        `expected INPUT_INVALID for malformed imagePath ${badPath}, got ${JSON.stringify(r.body)}`,
      );
      assert(
        r.events.length === 0,
        `malformed imagePath ${badPath} must not check access, read Storage or call provider, got ${r.events.join(', ')}`,
      );
    }
  },
);

Deno.test(
  'extractPrescription lets owner and helper through: access check -> Storage read -> provider gets the photo bytes',
  async () => {
    for (const allowedUser of [OWNER_A, HELPER_A]) {
      const r = await makeInjectedCall(allowedUser);
      assert(
        r.body.ok === true,
        `expected ${allowedUser} to succeed, got ${JSON.stringify(r.body)}`,
      );
      assert(
        r.events.join(' -> ') ===
          [
            `access:${CIRCLE_A}:${allowedUser}`,
            `storage:read:${VALID_IMAGE_PATH}`,
            'provider:generate',
          ].join(' -> '),
        `expected access check -> storage read -> provider generate, got ${r.events.join(' -> ')}`,
      );
      const image = r.providerRequests[0]?.image;
      assert(
        image?.mimeType === 'image/jpeg' && sameBytes(image.bytes, JPEG_BYTES),
        'provider request must carry the photo bytes read from Storage as image: { bytes, mimeType: "image/jpeg" }',
      );
    }

    // The same person is allowed in Circle B, where they are a helper.
    const dualInB = await makeInjectedCall(DUAL, { imagePath: `${CIRCLE_B}/${PHOTO_UUID}.jpg` });
    assert(dualInB.body.ok === true, 'a helper of Circle B can extract a Circle B photo');
  },
);

Deno.test(
  'extractPrescription: missing, non-JPEG or over-2 MB photo is INPUT_INVALID and never reaches the provider',
  async () => {
    const cases: Array<[string, { bytes: Uint8Array; contentType: string } | null]> = [
      ['photo already deleted', null],
      ['PNG content type', { bytes: JPEG_BYTES, contentType: 'image/png' }],
      ['over 2 MB', { bytes: new Uint8Array(2 * 1024 * 1024 + 1), contentType: 'image/jpeg' }],
    ];
    for (const [label, photo] of cases) {
      const r = await makeInjectedCall(OWNER_A, { photo });
      assert(
        r.body.ok === false &&
          r.body.error?.code === 'INPUT_INVALID' &&
          r.body.error.retryable === false,
        `${label}: expected INPUT_INVALID, got ${JSON.stringify(r.body)}`,
      );
      assert(!r.events.includes('provider:generate'), `${label}: provider must not be called`);
    }
  },
);

Deno.test('extractPrescription fails closed when the membership check cannot run', async () => {
  const r = await makeInjectedCall(OWNER_A, { accessThrows: true });
  assert(
    r.body.ok === false &&
      r.body.error?.code === 'PROVIDER_ERROR' &&
      r.body.error.retryable === true,
    `expected retryable PROVIDER_ERROR, got ${JSON.stringify(r.body)}`,
  );
  assert(!readOrProvider(r.events), 'no Storage read or provider call when the access check fails');
});

// Before CC-5a this test said summarizeVisit did no circle check at all. CC-5a changed that on purpose
// (step 15 plan, item 2.2): the caller must be owner or helper of the circle named in the input. What
// stays true is that summarizeVisit never reads a prescription photo.
Deno.test(
  'summarizeVisit checks the circle named in its input and never reads a prescription photo',
  async () => {
    const events: string[] = [];
    const accessChecks: Array<{ userId: string; circleId: string }> = [];
    const stubProvider: AiProvider = {
      generate: async (req) => ({
        output: FAKE_FIXTURES[req.task],
        inputTokens: 1,
        outputTokens: 1,
      }),
    };
    const visitCircle = 'cc5a0001-0000-4000-8000-000000000001';
    const baseDeps = {
      verifyJwt: async () => ({ userId: VIEWER_A }),
      countRecentCalls: async () => 0,
      logCall: async () => {},
      providers: { fake: stubProvider, gemini: stubProvider, anthropic: stubProvider },
      checkCircleFamilyEntitlement: async () => ({ allowed: true as const }),
      checkCircleMedicationIds: async () => true,
      readPrescriptionPhoto: async () => {
        events.push('read');
        return null;
      },
    };
    const input = { circleId: visitCircle, text: 'Doctor said keep Metformin.', knownMeds: [] };

    const refused = await callGateway(
      {
        ...baseDeps,
        checkPrescriptionCircleAccess: async (opts: { userId: string; circleId: string }) => {
          accessChecks.push(opts);
          return false;
        },
      } as RxGatewayDeps,
      'carecircle.summarizeVisit',
      input,
    );
    assert(
      refused.body.ok === false && refused.body.error?.code === 'INPUT_INVALID',
      `a caller without owner or helper access is refused, got ${JSON.stringify(refused.body)}`,
    );
    assert(
      accessChecks.length === 1 &&
        accessChecks[0].userId === VIEWER_A &&
        accessChecks[0].circleId === visitCircle,
      `access is checked once for that circle, got ${JSON.stringify(accessChecks)}`,
    );

    const allowed = await callGateway(
      { ...baseDeps, checkPrescriptionCircleAccess: async () => true } as RxGatewayDeps,
      'carecircle.summarizeVisit',
      input,
    );
    assert(
      allowed.body.ok === true,
      `an allowed caller gets a draft, got ${JSON.stringify(allowed.body)}`,
    );
    assert(events.length === 0, `summarizeVisit must not touch photos, got ${events.join(', ')}`);
  },
);

// A tiny PostgREST stand-in: applies `col=eq.x` and `col=in.(a,b)` filters to the MEMBERS table, so a
// query that forgets the circle filter (or the role filter) gets the wrong answer, like the real thing.
function filterMembers(url: URL): typeof MEMBERS {
  let rows = [...MEMBERS];
  for (const [key, raw] of url.searchParams) {
    if (['select', 'limit', 'order', 'offset'].includes(key)) continue;
    const col = key as keyof (typeof MEMBERS)[number];
    if (raw.startsWith('eq.')) {
      const v = raw.slice(3);
      rows = rows.filter((r) => r[col] === v);
    } else if (raw.startsWith('in.(') && raw.endsWith(')')) {
      const vs = raw
        .slice(4, -1)
        .split(',')
        .map((s) => s.trim().replace(/^"|"$/g, ''));
      rows = rows.filter((r) => vs.includes(r[col]));
    } else {
      throw new Error(`Unsupported PostgREST filter in test: ${key}=${raw}`);
    }
  }
  return rows;
}

const defaultAdapterCall = async (callerUserId: string) => {
  const seen: Array<{ url: string; method: string; body: string }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : '';
    seen.push({ url, method, body });
    const u = new URL(url);
    if (u.pathname === '/rest/v1/circle_members') {
      return Response.json(filterMembers(u));
    }
    if (u.pathname.startsWith('/storage/v1/object/')) {
      return new Response(JPEG_BYTES, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    if (u.hostname === 'generativelanguage.googleapis.com') {
      return Response.json({
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify(FAKE_FIXTURES['carecircle.extractPrescription']) }],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 },
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  const handler = createAiGatewayHandler({
    verifyJwt: async () => ({ userId: callerUserId }),
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
      headers: { 'content-type': 'application/json', authorization: 'Bearer user-jwt' },
      body: JSON.stringify({
        task: 'carecircle.extractPrescription',
        input: { imagePath: VALID_IMAGE_PATH },
        requestId: REQ_ID,
      }),
    }),
  );
  return { body: (await res.json()) as GatewayBody, seen };
};

Deno.test(
  'extractPrescription default Supabase adapters: membership is checked for THIS circle and role before any download',
  async () => {
    for (const user of [VIEWER_A, OWNER_B, DUAL, OUTSIDER]) {
      const { body, seen } = await defaultAdapterCall(user);
      assert(body.ok === false, `${user} must be refused by the default circle_members check`);
      assert(
        seen.some((s) => s.url.includes('/rest/v1/circle_members')) &&
          !seen.some((s) => s.url.includes('/storage/v1/object/')) &&
          !seen.some((s) => s.url.includes('generativelanguage.googleapis.com')),
        `expected a circle_members query and zero Storage or Gemini calls for ${user}, got: ${seen.map((s) => s.url).join(', ')}`,
      );
    }
  },
);

Deno.test(
  'extractPrescription default adapters: owner downloads from prescription-photos and Gemini receives the JPEG inline',
  async () => {
    const { body, seen } = await defaultAdapterCall(OWNER_A);
    assert(
      body.ok === true,
      `owner must succeed with default adapters, got ${JSON.stringify(body)}`,
    );
    const storageCalls = seen.filter((s) => s.url.includes('/storage/v1/object/'));
    assert(
      storageCalls.length === 1 &&
        storageCalls[0].url.endsWith(`/prescription-photos/${VALID_IMAGE_PATH}`),
      `expected one download of prescription-photos/${VALID_IMAGE_PATH}, got ${storageCalls.map((s) => s.url).join(', ')}`,
    );
    const geminiCall = seen.find((s) => s.url.includes('generativelanguage.googleapis.com'));
    assert(!!geminiCall, 'Gemini must be called for the owner');
    const sent = JSON.parse(geminiCall!.body) as {
      contents?: Array<{
        parts?: Array<{
          inlineData?: { mimeType?: string; data?: string };
          inline_data?: { mime_type?: string; data?: string };
        }>;
      }>;
    };
    const parts = sent.contents?.flatMap((c) => c.parts ?? []) ?? [];
    const inline = parts
      .map(
        (p) =>
          p.inlineData ??
          (p.inline_data && { mimeType: p.inline_data.mime_type, data: p.inline_data.data }),
      )
      .find(Boolean);
    assert(
      inline?.mimeType === 'image/jpeg' && inline.data === toBase64(JPEG_BYTES),
      'Gemini request must include the downloaded photo as an inline image/jpeg part (base64)',
    );
  },
);

Deno.test(
  'a migration creates the prescription-photos bucket (config.toml alone does not reach the hosted project)',
  async () => {
    const dir = new URL('../../migrations/', import.meta.url);
    let found = false;
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.name.endsWith('.sql')) continue;
      const sql = await Deno.readTextFile(new URL(entry.name, dir));
      if (/insert\s+into\s+storage\.buckets/i.test(sql) && sql.includes("'prescription-photos'"))
        found = true;
    }
    assert(found, 'expected a migration with insert into storage.buckets for prescription-photos');
  },
);
