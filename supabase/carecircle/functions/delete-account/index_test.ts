// CC-10 [safety 1/2]: Deno tests for `POST /functions/v1/delete-account`.
//
// Proposed handler to be added in CC-10 [safety 2/2]:
// - `supabase/carecircle/functions/delete-account/handler.ts` exporting `createDeleteAccountHandler(deps)`
// - `supabase/carecircle/functions/delete-account/index.ts` serving `Deno.serve(createDeleteAccountHandler())`

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

const MULTI_CIRCLE_ID = '11111111-1111-4111-8111-111111111111';
const SOLO_CIRCLE_ID = '22222222-2222-4222-8222-222222222222';
const MULTI_OWNER_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const HELPER_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const SOLO_OWNER_ID = 'cccccccc-3333-4333-8333-333333333333';

interface FakeDatabaseState {
  authUsers: Set<string>;
  users_profile: Array<{ user_id: string }>;
  circle_members: Array<{
    circle_id: string;
    user_id: string;
    role: 'owner' | 'helper' | 'viewer';
  }>;
  push_tokens: Array<{ user_id: string; token: string }>;
  entitlements: Array<{ user_id: string; entitlement: string }>;
  ai_calls: Array<{ id: string; user_id: string }>;
  circles: Array<{ id: string; created_by: string | null }>;
  invites: Array<{ id: string; circle_id: string; used_by: string | null }>;
  medications: Array<{ id: string; circle_id: string }>;
  dose_events: Array<{ id: string; circle_id: string; acted_by: string | null }>;
  appointments: Array<{ id: string; circle_id: string; driver_user_id: string | null }>;
  tasks: Array<{
    id: string;
    circle_id: string;
    assignee: string | null;
    done_by: string | null;
  }>;
  visit_notes: Array<{ id: string; circle_id: string; created_by: string | null }>;
  log_entries: Array<{
    id: string;
    circle_id: string;
    created_by: string | null;
    ref_id: string | null;
  }>;
  storageObjects: Record<string, string[]>;
}

function createSeededState(): FakeDatabaseState {
  return {
    authUsers: new Set([MULTI_OWNER_ID, HELPER_ID, SOLO_OWNER_ID]),
    users_profile: [
      { user_id: MULTI_OWNER_ID },
      { user_id: HELPER_ID },
      { user_id: SOLO_OWNER_ID },
    ],
    circle_members: [
      { circle_id: MULTI_CIRCLE_ID, user_id: MULTI_OWNER_ID, role: 'owner' },
      { circle_id: MULTI_CIRCLE_ID, user_id: HELPER_ID, role: 'helper' },
      { circle_id: SOLO_CIRCLE_ID, user_id: SOLO_OWNER_ID, role: 'owner' },
    ],
    push_tokens: [
      { user_id: HELPER_ID, token: 'ExponentPushToken[helper]' },
      { user_id: SOLO_OWNER_ID, token: 'ExponentPushToken[solo]' },
    ],
    entitlements: [
      { user_id: HELPER_ID, entitlement: 'carecircle_family' },
      { user_id: SOLO_OWNER_ID, entitlement: 'carecircle_family' },
    ],
    ai_calls: [
      { id: 'ai-1', user_id: HELPER_ID },
      { id: 'ai-2', user_id: SOLO_OWNER_ID },
    ],
    circles: [
      { id: MULTI_CIRCLE_ID, created_by: MULTI_OWNER_ID },
      { id: SOLO_CIRCLE_ID, created_by: SOLO_OWNER_ID },
    ],
    invites: [
      { id: 'inv-1', circle_id: MULTI_CIRCLE_ID, used_by: HELPER_ID },
      { id: 'inv-2', circle_id: SOLO_CIRCLE_ID, used_by: null },
    ],
    medications: [
      { id: 'med-m', circle_id: MULTI_CIRCLE_ID },
      { id: 'med-s', circle_id: SOLO_CIRCLE_ID },
    ],
    dose_events: [
      { id: 'dose-m', circle_id: MULTI_CIRCLE_ID, acted_by: HELPER_ID },
      { id: 'dose-s', circle_id: SOLO_CIRCLE_ID, acted_by: SOLO_OWNER_ID },
    ],
    appointments: [
      { id: 'appt-m', circle_id: MULTI_CIRCLE_ID, driver_user_id: HELPER_ID },
      { id: 'appt-s', circle_id: SOLO_CIRCLE_ID, driver_user_id: SOLO_OWNER_ID },
    ],
    tasks: [
      { id: 'task-m', circle_id: MULTI_CIRCLE_ID, assignee: HELPER_ID, done_by: HELPER_ID },
      { id: 'task-s', circle_id: SOLO_CIRCLE_ID, assignee: SOLO_OWNER_ID, done_by: SOLO_OWNER_ID },
    ],
    visit_notes: [
      { id: 'vn-m', circle_id: MULTI_CIRCLE_ID, created_by: HELPER_ID },
      { id: 'vn-s', circle_id: SOLO_CIRCLE_ID, created_by: SOLO_OWNER_ID },
    ],
    log_entries: [
      { id: 'log-m', circle_id: MULTI_CIRCLE_ID, created_by: HELPER_ID, ref_id: HELPER_ID },
      { id: 'log-s', circle_id: SOLO_CIRCLE_ID, created_by: SOLO_OWNER_ID, ref_id: SOLO_OWNER_ID },
    ],
    storageObjects: {
      'prescription-photos': [
        `${HELPER_ID}/11111111-1111-4111-8111-111111111111.jpg`,
        `${SOLO_OWNER_ID}/22222222-2222-4222-8222-222222222222.jpg`,
      ],
      'visit-audio': [`${SOLO_CIRCLE_ID}/33333333-3333-4333-8333-333333333333.m4a`],
      'log-exports': [`${SOLO_CIRCLE_ID}/44444444-4444-4444-8444-444444444444.pdf`],
    },
  };
}

function countUserReferencesInDb(state: FakeDatabaseState, userId: string): number {
  let count = 0;
  count += state.users_profile.filter((r) => r.user_id === userId).length;
  count += state.circle_members.filter((r) => r.user_id === userId).length;
  count += state.push_tokens.filter((r) => r.user_id === userId).length;
  count += state.entitlements.filter((r) => r.user_id === userId).length;
  count += state.ai_calls.filter((r) => r.user_id === userId).length;
  count += state.circles.filter((r) => r.created_by === userId).length;
  count += state.invites.filter((r) => r.used_by === userId).length;
  count += state.dose_events.filter((r) => r.acted_by === userId).length;
  count += state.appointments.filter((r) => r.driver_user_id === userId).length;
  count += state.tasks.filter((r) => r.assignee === userId || r.done_by === userId).length;
  count += state.visit_notes.filter((r) => r.created_by === userId).length;
  count += state.log_entries.filter((r) => r.created_by === userId || r.ref_id === userId).length;
  return count;
}

function countStorageObjectsWithPrefix(state: FakeDatabaseState, prefix: string): number {
  let count = 0;
  for (const objects of Object.values(state.storageObjects)) {
    count += objects.filter((p) => p.startsWith(`${prefix}/`)).length;
  }
  return count;
}

async function loadCreateDeleteAccountHandler(): Promise<
  (deps: Record<string, unknown>) => (req: Request) => Promise<Response>
> {
  const modPath = './handler.ts';
  const mod = (await import(modPath)) as {
    createDeleteAccountHandler: (
      deps: Record<string, unknown>,
    ) => (req: Request) => Promise<Response>;
  };
  return mod.createDeleteAccountHandler;
}

Deno.test('CC-10 delete-account: refuses missing or invalid JWT with 401', async () => {
  const createDeleteAccountHandler = await loadCreateDeleteAccountHandler();
  const state = createSeededState();
  const handler = createDeleteAccountHandler({
    verifyJwt: async () => null,
    state,
  });

  const res = await handler(
    new Request('https://example.test/functions/v1/delete-account', {
      method: 'POST',
      headers: { authorization: 'Bearer invalid-jwt' },
    }),
  );
  assert(res.status === 401, `expected 401 for invalid JWT, got ${res.status}`);
  assert(state.authUsers.size === 3, 'no user may be deleted on 401');
});

Deno.test(
  'CC-10 delete-account: owner of a circle with other members is refused with OWNER_MUST_TRANSFER and nothing is deleted',
  async () => {
    const createDeleteAccountHandler = await loadCreateDeleteAccountHandler();
    const state = createSeededState();
    const handler = createDeleteAccountHandler({
      verifyJwt: async (token: string) =>
        token === 'jwt-multi-owner' ? { userId: MULTI_OWNER_ID } : null,
      state,
    });

    const res = await handler(
      new Request('https://example.test/functions/v1/delete-account', {
        method: 'POST',
        headers: { authorization: 'Bearer jwt-multi-owner' },
      }),
    );
    assert(res.status >= 400 && res.status < 500, `expected 4xx status, got ${res.status}`);
    const body = (await res.json()) as {
      ok?: boolean;
      code?: string;
      error?: { code?: string };
    };
    assert(
      body.code === 'OWNER_MUST_TRANSFER' || body.error?.code === 'OWNER_MUST_TRANSFER',
      `expected OWNER_MUST_TRANSFER, got ${JSON.stringify(body)}`,
    );
    assert(state.authUsers.has(MULTI_OWNER_ID), 'owner of multi-member circle must not be deleted');
    assert(
      state.circles.some((c) => c.id === MULTI_CIRCLE_ID),
      'multi-member circle must not be deleted',
    );
  },
);

Deno.test(
  'CC-10 delete-account: solo owner deletes their circle, all domain rows, all Storage objects, and leaves 0 rows with their user_id',
  async () => {
    const createDeleteAccountHandler = await loadCreateDeleteAccountHandler();
    const state = createSeededState();
    const handler = createDeleteAccountHandler({
      verifyJwt: async (token: string) =>
        token === 'jwt-solo-owner' ? { userId: SOLO_OWNER_ID } : null,
      state,
    });

    const res = await handler(
      new Request('https://example.test/functions/v1/delete-account', {
        method: 'POST',
        headers: { authorization: 'Bearer jwt-solo-owner' },
      }),
    );
    assert(res.status === 200, `expected 200 for solo owner delete, got ${res.status}`);
    const body = (await res.json()) as { ok?: boolean };
    assert(body.ok === true, 'expected { ok: true }');

    assert(
      countUserReferencesInDb(state, SOLO_OWNER_ID) === 0,
      'expected 0 rows with solo owner user_id across all tables',
    );
    assert(
      !state.circles.some((c) => c.id === SOLO_CIRCLE_ID),
      'solo owner circle must be deleted',
    );
    assert(
      !state.medications.some((m) => m.circle_id === SOLO_CIRCLE_ID) &&
        !state.dose_events.some((d) => d.circle_id === SOLO_CIRCLE_ID) &&
        !state.appointments.some((a) => a.circle_id === SOLO_CIRCLE_ID) &&
        !state.tasks.some((t) => t.circle_id === SOLO_CIRCLE_ID) &&
        !state.visit_notes.some((v) => v.circle_id === SOLO_CIRCLE_ID) &&
        !state.log_entries.some((l) => l.circle_id === SOLO_CIRCLE_ID),
      'all domain rows and log_entries in solo owner circle must be deleted',
    );
    assert(
      countStorageObjectsWithPrefix(state, SOLO_OWNER_ID) === 0 &&
        countStorageObjectsWithPrefix(state, SOLO_CIRCLE_ID) === 0,
      'expected 0 Storage objects under solo owner or solo circle prefix in every bucket',
    );
  },
);

Deno.test(
  'CC-10 delete-account: helper account deletion leaves 0 rows with their user_id, deletes their Storage objects, and calling delete-account twice is safe',
  async () => {
    const createDeleteAccountHandler = await loadCreateDeleteAccountHandler();
    const state = createSeededState();
    const handler = createDeleteAccountHandler({
      verifyJwt: async (token: string) => (token === 'jwt-helper' ? { userId: HELPER_ID } : null),
      state,
    });

    const res1 = await handler(
      new Request('https://example.test/functions/v1/delete-account', {
        method: 'POST',
        headers: { authorization: 'Bearer jwt-helper' },
      }),
    );
    assert(res1.status === 200, `expected 200 on first delete-account call, got ${res1.status}`);
    assert(
      countUserReferencesInDb(state, HELPER_ID) === 0,
      'expected 0 rows referencing helper user_id across all tables',
    );
    assert(
      countStorageObjectsWithPrefix(state, HELPER_ID) === 0,
      'expected 0 Storage objects under helper prefix across all buckets',
    );

    // Surviving multi-member circle keeps its domain rows with user columns set to null
    assert(
      state.dose_events.some((d) => d.id === 'dose-m' && d.acted_by === null) &&
        state.appointments.some((a) => a.id === 'appt-m' && a.driver_user_id === null) &&
        state.tasks.some((t) => t.id === 'task-m' && t.assignee === null && t.done_by === null) &&
        state.visit_notes.some((v) => v.id === 'vn-m' && v.created_by === null) &&
        state.log_entries.some(
          (l) => l.id === 'log-m' && l.created_by === null && l.ref_id === null,
        ),
      'surviving circle rows must remain with user columns set to null',
    );

    // Second call is safe (idempotent)
    const res2 = await handler(
      new Request('https://example.test/functions/v1/delete-account', {
        method: 'POST',
        headers: { authorization: 'Bearer jwt-helper' },
      }),
    );
    assert(
      res2.status === 200 || res2.status === 401,
      `expected second delete-account call to be safe (200 or 401), got ${res2.status}`,
    );
  },
);
