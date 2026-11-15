// F-5 [safety]: the one server-side entitlement check. Every Edge Function that gates a Family
// feature (the AI gateway for summarizeVisit, PDF export, member limits in CC-8) MUST call this and
// nothing else. It reads only the `entitlements` table (spec Part 1 > Entitlements), never the client.
import {
  verifyServerEntitlement,
  type EntitlementReadStore,
  type EntitlementRow,
} from './entitlements.ts';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-15T10:00:00.000Z');

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
};
const assertEquals = (actual: unknown, expected: unknown, msg: string): void => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`Assertion failed: ${msg}\n  actual:   ${a}\n  expected: ${e}`);
};

const row = (overrides: Partial<EntitlementRow> = {}): EntitlementRow => ({
  user_id: USER_A,
  entitlement: 'carecircle_family',
  active: true,
  expires_at: '2026-12-15T10:00:00.000Z',
  ...overrides,
});

// A store that only knows the rows it is given and records every lookup.
function storeWith(rows: EntitlementRow[]) {
  const lookups: Array<{ userId: string; entitlement: string }> = [];
  const store: EntitlementReadStore = {
    async getEntitlement(userId, entitlement) {
      lookups.push({ userId, entitlement });
      const found = rows.find((r) => r.user_id === userId && r.entitlement === entitlement);
      return { data: found ?? null, error: null };
    },
  };
  return { store, lookups };
}

const FORGED_CLAIM = {
  entitlement: 'carecircle_family',
  active: true,
  isPro: true,
  expires_at: null,
  user_id: USER_B,
  customerInfo: { entitlements: { active: { carecircle_family: { isActive: true } } } },
};

Deno.test('allows a user whose server row is active and not expired', async () => {
  const { store, lookups } = storeWith([row()]);
  const result = await verifyServerEntitlement({ authenticatedUserId: USER_A, store, now: NOW });
  assertEquals(result, { allowed: true }, 'active row allows');
  assertEquals(
    lookups,
    [{ userId: USER_A, entitlement: 'carecircle_family' }],
    'defaults to carecircle_family and looks up the authenticated user only',
  );
});

Deno.test('a forged client claim never grants access', async () => {
  // Server row inactive.
  let s = storeWith([row({ active: false, expires_at: null })]);
  assertEquals(
    await verifyServerEntitlement({
      authenticatedUserId: USER_A,
      clientClaim: FORGED_CLAIM,
      store: s.store,
      now: NOW,
    }),
    { allowed: false, reason: 'ENTITLEMENT_REQUIRED' },
    'inactive row + forged claim is refused',
  );

  // No server row at all (never paid).
  s = storeWith([]);
  assertEquals(
    await verifyServerEntitlement({
      authenticatedUserId: USER_A,
      clientClaim: FORGED_CLAIM,
      store: s.store,
      now: NOW,
    }),
    { allowed: false, reason: 'ENTITLEMENT_REQUIRED' },
    'missing row + forged claim is refused',
  );
});

Deno.test('checks the authenticated user, never a user id taken from the request', async () => {
  // User B pays, user A does not. A sends a claim naming B.
  const { store, lookups } = storeWith([row({ user_id: USER_B })]);
  const result = await verifyServerEntitlement({
    authenticatedUserId: USER_A,
    clientClaim: { ...FORGED_CLAIM, user_id: USER_B, userId: USER_B },
    store,
    now: NOW,
  });
  assertEquals(result, { allowed: false, reason: 'ENTITLEMENT_REQUIRED' }, 'A borrows B row');
  assert(
    lookups.every((l) => l.userId === USER_A),
    'only the authenticated user id is looked up',
  );
});

Deno.test('expired rows are refused even when active is still true', async () => {
  for (const expiresAt of [
    '2026-11-15T09:59:59.999Z', // just before now
    '2026-11-15T10:00:00.000Z', // exactly now: expired (expires_at <= now)
    '2025-01-01T00:00:00.000Z',
  ]) {
    const { store } = storeWith([row({ expires_at: expiresAt })]);
    assertEquals(
      await verifyServerEntitlement({ authenticatedUserId: USER_A, store, now: NOW }),
      { allowed: false, reason: 'ENTITLEMENT_REQUIRED' },
      `expires_at ${expiresAt} is refused`,
    );
  }
  const { store } = storeWith([row({ expires_at: '2026-11-15T10:00:00.001Z' })]);
  assertEquals(
    await verifyServerEntitlement({ authenticatedUserId: USER_A, store, now: NOW }),
    { allowed: true },
    '1 ms in the future is still allowed',
  );
});

Deno.test(
  'active with no expiry (lifetime or promotional) is allowed; inactive with no expiry is not',
  async () => {
    let s = storeWith([row({ expires_at: null })]);
    assertEquals(
      await verifyServerEntitlement({ authenticatedUserId: USER_A, store: s.store, now: NOW }),
      { allowed: true },
      'active + null expiry allowed',
    );
    s = storeWith([row({ active: false, expires_at: '2027-01-01T00:00:00.000Z' })]);
    assertEquals(
      await verifyServerEntitlement({ authenticatedUserId: USER_A, store: s.store, now: NOW }),
      { allowed: false, reason: 'ENTITLEMENT_REQUIRED' },
      'inactive + future expiry refused (a refund sets active = false before the period ends)',
    );
  },
);

Deno.test('only the requested entitlement counts', async () => {
  const { store } = storeWith([
    row({ entitlement: 'some_other_app_pro' as EntitlementRow['entitlement'] }),
  ]);
  assertEquals(
    await verifyServerEntitlement({ authenticatedUserId: USER_A, store, now: NOW }),
    { allowed: false, reason: 'ENTITLEMENT_REQUIRED' },
    'a row for another entitlement does not unlock carecircle_family',
  );
});

Deno.test('fails closed when the store errors, throws or returns something odd', async () => {
  const errored: EntitlementReadStore = {
    async getEntitlement() {
      return { data: null, error: { message: 'PostgREST timeout' } };
    },
  };
  assertEquals(
    await verifyServerEntitlement({
      authenticatedUserId: USER_A,
      clientClaim: FORGED_CLAIM,
      store: errored,
      now: NOW,
    }),
    { allowed: false, reason: 'STORE_ERROR' },
    'error result fails closed',
  );

  // An error together with a row (partial response) still fails closed.
  const erroredWithRow: EntitlementReadStore = {
    async getEntitlement() {
      return { data: row(), error: { message: 'partial' } };
    },
  };
  assertEquals(
    await verifyServerEntitlement({ authenticatedUserId: USER_A, store: erroredWithRow, now: NOW }),
    { allowed: false, reason: 'STORE_ERROR' },
    'error + row fails closed',
  );

  const throwing: EntitlementReadStore = {
    async getEntitlement() {
      throw new Error('network down');
    },
  };
  assertEquals(
    await verifyServerEntitlement({ authenticatedUserId: USER_A, store: throwing, now: NOW }),
    { allowed: false, reason: 'STORE_ERROR' },
    'a thrown error fails closed instead of crashing or allowing',
  );

  // Rows whose fields are not exactly what the table promises are refused.
  for (const odd of [
    { ...row(), active: 'true' },
    { ...row(), active: 1 },
    { ...row(), active: null },
    { ...row(), expires_at: 'not a date' },
    { ...row(), user_id: USER_B },
    { ...row(), entitlement: 'some_other_app_pro' },
  ]) {
    const store: EntitlementReadStore = {
      async getEntitlement() {
        return { data: odd as unknown as EntitlementRow, error: null };
      },
    };
    const result = await verifyServerEntitlement({ authenticatedUserId: USER_A, store, now: NOW });
    assert(result.allowed === false, `odd row ${JSON.stringify(odd)} is refused`);
  }
});

Deno.test('refuses when there is no authenticated user id', async () => {
  const { store, lookups } = storeWith([row({ user_id: '' })]);
  for (const id of ['', '   ']) {
    const result = await verifyServerEntitlement({ authenticatedUserId: id, store, now: NOW });
    assert(result.allowed === false, `empty user id "${id}" is refused`);
  }
  assertEquals(lookups, [], 'no lookup is made without a user id');
});
