// CC-2b [safety 1/2], review additions: the PostgREST store behind `mark-missed`, and the call to
// `send-push`. The handler tests in `index_test.ts` use a fake store that already filters by status,
// time and role, so these tests check that the real store does that filtering too.
//
// Required in CC-2b [safety 2/2], `supabase/carecircle/functions/mark-missed/store.ts`:
// - `createMarkMissedPostgrestStore(supabaseUrl: string, serviceRoleKey: string, fetchImpl?: typeof fetch)`
//   returning the `MarkMissedStore` used by the handler.
// - `createSendPushViaFunction(supabaseUrl: string, serviceRoleKey: string, fetchImpl?: typeof fetch)`
//   returning `(payload) => Promise<{ ok: boolean; sent?: number }>`: POSTs the payload to
//   `<supabaseUrl>/functions/v1/send-push` with `Authorization: Bearer <serviceRoleKey>`, and answers
//   `{ ok: false }` (never throws away the failure) when send-push answers an error.
// `index.ts` wires both with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

interface DoseRow {
  id: string;
  medication_id: string;
  circle_id: string;
  due_at: string;
  status: 'pending' | 'given' | 'skipped' | 'missed';
  acted_by: string | null;
  acted_at: string | null;
}

interface MemberRow {
  circle_id: string;
  user_id: string;
  role: 'owner' | 'helper' | 'viewer';
}

interface MarkMissedStore {
  listOverduePendingDoses(cutoffIso: string): Promise<DoseRow[]>;
  markDoseMissedIfPending(doseEventId: string): Promise<{ updated: boolean }>;
  listCircleOwnerAndHelperUserIds(circleId: string): Promise<string[]>;
}

interface PushPayload {
  userIds: string[];
  title: string;
  body: string;
  data: Record<string, string>;
}

interface StoreModule {
  createMarkMissedPostgrestStore: (
    supabaseUrl: string,
    serviceRoleKey: string,
    fetchImpl?: typeof fetch,
  ) => MarkMissedStore;
  createSendPushViaFunction: (
    supabaseUrl: string,
    serviceRoleKey: string,
    fetchImpl?: typeof fetch,
  ) => (payload: PushPayload) => Promise<{ ok: boolean; sent?: number }>;
}

interface HandlerModule {
  createMarkMissedHandler: (deps: {
    cronSecret?: string;
    now?: () => Date;
    store: MarkMissedStore;
    sendPush: (payload: PushPayload) => Promise<{ ok: boolean; sent?: number }>;
  }) => (req: Request) => Promise<Response>;
}

async function loadStoreModule(): Promise<StoreModule> {
  const modPath = './store.ts';
  return (await import(modPath)) as StoreModule;
}

async function loadHandlerModule(): Promise<HandlerModule> {
  const modPath = './handler.ts';
  return (await import(modPath)) as HandlerModule;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const SUPABASE_URL = 'http://supabase.test';
const SERVICE_KEY = 'service-role-key-for-mark-missed-store-tests';
const MAX_ROWS = 1000;

const CIRCLE_A = 'c2bc0001-0000-4000-8000-000000000001';
const CIRCLE_B = 'c2bc0002-0000-4000-8000-000000000002';
const MED_A = 'c2b20001-0000-4000-8000-000000000001';
const MED_B = 'c2b20002-0000-4000-8000-000000000002';
const OWNER_A = 'c2b00001-0000-4000-8000-000000000001';
const HELPER_A1 = 'c2b00002-0000-4000-8000-000000000002';
const HELPER_A2 = 'c2b00003-0000-4000-8000-000000000003';
const VIEWER_A = 'c2b00004-0000-4000-8000-000000000004';
const OWNER_B = 'c2b00005-0000-4000-8000-000000000005';

function doseId(i: number): string {
  return `d0000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
}

type Filter = (row: Record<string, unknown>) => boolean;

/** Parses one PostgREST filter value such as `eq.pending`, `lte.2026-...`, `in.(owner,helper)`. */
function parseFilter(column: string, raw: string): Filter {
  const dot = raw.indexOf('.');
  const op = raw.slice(0, dot);
  const value = raw.slice(dot + 1);
  const cell = (row: Record<string, unknown>) => row[column];
  const asTime = (v: unknown) => Date.parse(String(v));
  const isTime = column.endsWith('_at');
  const cmp = (a: unknown, b: string): number =>
    isTime ? asTime(a) - asTime(b) : String(a) < b ? -1 : String(a) > b ? 1 : 0;
  switch (op) {
    case 'eq':
      return (row) => (isTime ? cmp(cell(row), value) === 0 : String(cell(row)) === value);
    case 'neq':
      return (row) => (isTime ? cmp(cell(row), value) !== 0 : String(cell(row)) !== value);
    case 'lt':
      return (row) => cmp(cell(row), value) < 0;
    case 'lte':
      return (row) => cmp(cell(row), value) <= 0;
    case 'gt':
      return (row) => cmp(cell(row), value) > 0;
    case 'gte':
      return (row) => cmp(cell(row), value) >= 0;
    case 'in': {
      const list = value.replace(/^\(/, '').replace(/\)$/, '').split(',');
      return (row) => list.includes(String(cell(row)));
    }
    case 'is':
      return (row) => (value === 'null' ? cell(row) === null : String(cell(row)) === value);
    default:
      throw new Error(`fake PostgREST: unsupported filter ${column}=${raw}`);
  }
}

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);

/**
 * A fake PostgREST over in-memory `dose_events` and `circle_members`. Like the real one, it never
 * returns more than MAX_ROWS rows to a GET, applies every column filter it is given, and refuses
 * requests without the service-role key.
 */
function fakePostgrest(doses: DoseRow[], members: MemberRow[]) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const pushRequests: Array<{ headers: Headers; body: unknown }> = [];
  let pushResponse: () => Response = () => Response.json({ ok: true, sent: 1 });
  let restStatus = 200;

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    requests.push({ method, path: url.pathname + url.search, body });
    if (requests.length > 200) {
      // A paging loop that never ends would otherwise hang the test run.
      throw new Error('fake PostgREST: more than 200 requests, the store is looping');
    }

    if (url.pathname === '/functions/v1/send-push') {
      pushRequests.push({ headers, body });
      return pushResponse();
    }

    if (restStatus !== 200) {
      return Response.json({ message: 'database unavailable' }, { status: restStatus });
    }

    const auth = headers.get('authorization') ?? '';
    if (auth !== `Bearer ${SERVICE_KEY}` || headers.get('apikey') !== SERVICE_KEY) {
      return Response.json({ message: 'service role required' }, { status: 401 });
    }

    const table = url.pathname.replace('/rest/v1/', '');
    const rows: Array<Record<string, unknown>> =
      table === 'dose_events'
        ? (doses as unknown as Array<Record<string, unknown>>)
        : table === 'circle_members'
          ? (members as unknown as Array<Record<string, unknown>>)
          : [];
    if (table !== 'dose_events' && table !== 'circle_members') {
      throw new Error(`fake PostgREST: unexpected table ${table}`);
    }

    const filters: Filter[] = [];
    for (const [key, value] of url.searchParams.entries()) {
      if (RESERVED.has(key)) continue;
      filters.push(parseFilter(key, value));
    }
    let matched = rows.filter((row) => filters.every((f) => f(row)));

    const order = url.searchParams.get('order');
    if (order) {
      const [col, dir] = order.split('.');
      matched = [...matched].sort((a, b) => {
        const x = String(a[col!]);
        const y = String(b[col!]);
        return (x < y ? -1 : x > y ? 1 : 0) * (dir === 'desc' ? -1 : 1);
      });
    }

    if (method === 'GET') {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Math.min(Number(url.searchParams.get('limit') ?? MAX_ROWS), MAX_ROWS);
      return Response.json(matched.slice(offset, offset + limit).map((r) => ({ ...r })));
    }
    if (method === 'PATCH') {
      if (table !== 'dose_events') throw new Error('fake PostgREST: only dose_events is patched');
      for (const row of matched) Object.assign(row, body as Record<string, unknown>);
      const prefer = headers.get('prefer') ?? '';
      if (prefer.includes('return=representation')) {
        return Response.json(matched.map((r) => ({ ...r })));
      }
      return new Response(null, {
        status: 204,
        headers: { 'content-range': `0-${matched.length - 1}/${matched.length}` },
      });
    }
    throw new Error(`fake PostgREST: unexpected ${method} ${url.pathname}`);
  };

  return {
    fetchImpl: fetchImpl as typeof fetch,
    requests,
    pushRequests,
    setPushResponse: (fn: () => Response) => {
      pushResponse = fn;
    },
    /** Every PostgREST request answers this HTTP status (200 = normal). */
    setRestStatus: (status: number) => {
      restStatus = status;
    },
  };
}

function dose(
  id: string,
  dueAt: string,
  status: DoseRow['status'],
  circleId = CIRCLE_A,
  medicationId = MED_A,
): DoseRow {
  const acted = status === 'given' || status === 'skipped';
  return {
    id,
    medication_id: medicationId,
    circle_id: circleId,
    due_at: dueAt,
    status,
    acted_by: acted ? OWNER_A : null,
    acted_at: acted ? '2026-11-15T08:05:00.000Z' : null,
  };
}

const CUTOFF = '2026-11-15T11:00:00.000Z';

Deno.test(
  'store: lists every pending dose due at or before the cutoff, past the 1000-row PostgREST cap, and nothing else',
  async () => {
    const { createMarkMissedPostgrestStore } = await loadStoreModule();
    const overdueCount = 2 * MAX_ROWS + 7;
    const doses: DoseRow[] = [];
    for (let i = 1; i <= overdueCount; i += 1) {
      doses.push(dose(doseId(i), '2026-11-15T10:00:00.000Z', 'pending'));
    }
    doses.push(dose(doseId(9001), CUTOFF, 'pending')); // exactly at the cutoff: listed
    doses.push(dose(doseId(9002), '2026-11-15T11:00:01.000Z', 'pending')); // 1 s after: not listed
    doses.push(dose(doseId(9003), '2026-11-15T09:00:00.000Z', 'given'));
    doses.push(dose(doseId(9004), '2026-11-15T09:00:00.000Z', 'skipped'));
    doses.push(dose(doseId(9005), '2026-11-15T09:00:00.000Z', 'missed'));

    const pg = fakePostgrest(doses, []);
    const store = createMarkMissedPostgrestStore(SUPABASE_URL, SERVICE_KEY, pg.fetchImpl);
    const listed = await store.listOverduePendingDoses(CUTOFF);
    const ids = listed.map((d) => d.id);

    assert(new Set(ids).size === ids.length, 'no dose is listed twice');
    assert(
      listed.length === overdueCount + 1,
      `expected ${overdueCount + 1} overdue pending doses, got ${listed.length}`,
    );
    assert(ids.includes(doseId(9001)), 'a pending dose due exactly at the cutoff is listed');
    for (const id of [doseId(9002), doseId(9003), doseId(9004), doseId(9005)]) {
      assert(!ids.includes(id), `dose ${id} (not pending, or due after the cutoff) is not listed`);
    }
    assert(
      listed.every((d) => d.status === 'pending' && d.circle_id === CIRCLE_A),
      'rows come back with their status and circle_id',
    );
    assert(
      pg.requests.every((r) => r.method === 'GET'),
      'listing never writes anything',
    );
  },
);

Deno.test(
  'store: markDoseMissedIfPending changes only a pending dose, sets only status = missed, and says whether it changed',
  async () => {
    const { createMarkMissedPostgrestStore } = await loadStoreModule();
    const doses = [
      dose(doseId(1), '2026-11-15T10:00:00.000Z', 'pending'),
      dose(doseId(2), '2026-11-15T10:00:00.000Z', 'pending'),
      dose(doseId(3), '2026-11-15T09:00:00.000Z', 'given'),
      dose(doseId(4), '2026-11-15T09:00:00.000Z', 'skipped'),
      dose(doseId(5), '2026-11-15T09:00:00.000Z', 'missed'),
    ];
    const before = structuredClone(doses);
    const pg = fakePostgrest(doses, []);
    const store = createMarkMissedPostgrestStore(SUPABASE_URL, SERVICE_KEY, pg.fetchImpl);

    const first = await store.markDoseMissedIfPending(doseId(1));
    assert(first.updated === true, 'a pending dose is updated');
    assert(doses[0]!.status === 'missed', 'the pending dose is now missed');
    assert(
      doses[0]!.acted_by === null && doses[0]!.acted_at === null,
      'acted_by and acted_at stay null on a missed dose',
    );
    assert(
      JSON.stringify(doses[1]) === JSON.stringify(before[1]),
      'the other pending dose is not touched',
    );

    const again = await store.markDoseMissedIfPending(doseId(1));
    assert(again.updated === false, 'a dose already missed is not updated again');

    for (const i of [3, 4, 5]) {
      const res = await store.markDoseMissedIfPending(doseId(i));
      assert(res.updated === false, `dose ${i} (${before[i - 1]!.status}) is not updated`);
      assert(
        JSON.stringify(doses[i - 1]) === JSON.stringify(before[i - 1]),
        `dose ${i} (${before[i - 1]!.status}) is left exactly as it was`,
      );
    }

    const unknown = await store.markDoseMissedIfPending(doseId(999));
    assert(unknown.updated === false, 'an unknown dose id is not updated');

    const patches = pg.requests.filter((r) => r.method === 'PATCH');
    assert(patches.length > 0, 'the store updates with PATCH');
    for (const p of patches) {
      assert(
        JSON.stringify(Object.keys(p.body as Record<string, unknown>)) === '["status"]' &&
          (p.body as { status: string }).status === 'missed',
        `the update body sets only { status: 'missed' }, got ${JSON.stringify(p.body)}`,
      );
    }
  },
);

Deno.test(
  'store: listCircleOwnerAndHelperUserIds returns the owner and every helper of that circle, never viewers or other circles',
  async () => {
    const { createMarkMissedPostgrestStore } = await loadStoreModule();
    const members: MemberRow[] = [
      { circle_id: CIRCLE_A, user_id: OWNER_A, role: 'owner' },
      { circle_id: CIRCLE_A, user_id: HELPER_A1, role: 'helper' },
      { circle_id: CIRCLE_A, user_id: HELPER_A2, role: 'helper' },
      { circle_id: CIRCLE_A, user_id: VIEWER_A, role: 'viewer' },
      { circle_id: CIRCLE_B, user_id: OWNER_B, role: 'owner' },
    ];
    const pg = fakePostgrest([], members);
    const store = createMarkMissedPostgrestStore(SUPABASE_URL, SERVICE_KEY, pg.fetchImpl);

    const a = [...(await store.listCircleOwnerAndHelperUserIds(CIRCLE_A))].sort();
    assert(
      JSON.stringify(a) === JSON.stringify([OWNER_A, HELPER_A1, HELPER_A2].sort()),
      `circle A: expected owner and both helpers, got ${JSON.stringify(a)}`,
    );
    const b = await store.listCircleOwnerAndHelperUserIds(CIRCLE_B);
    assert(
      JSON.stringify(b) === JSON.stringify([OWNER_B]),
      `circle B: expected only its owner, got ${JSON.stringify(b)}`,
    );
  },
);

Deno.test(
  'store + handler: a real run through PostgREST misses only overdue pending doses, once, and pushes each circle only to its own owner and helpers',
  async () => {
    const { createMarkMissedPostgrestStore } = await loadStoreModule();
    const { createMarkMissedHandler } = await loadHandlerModule();
    const doses = [
      dose(doseId(1), '2026-11-15T10:59:00.000Z', 'pending', CIRCLE_A, MED_A),
      dose(doseId(2), '2026-11-15T10:30:00.000Z', 'pending', CIRCLE_B, MED_B),
      dose(doseId(3), '2026-11-15T11:30:00.000Z', 'pending', CIRCLE_A, MED_A),
      dose(doseId(4), '2026-11-15T09:00:00.000Z', 'given', CIRCLE_A, MED_A),
    ];
    const members: MemberRow[] = [
      { circle_id: CIRCLE_A, user_id: OWNER_A, role: 'owner' },
      { circle_id: CIRCLE_A, user_id: HELPER_A1, role: 'helper' },
      { circle_id: CIRCLE_A, user_id: VIEWER_A, role: 'viewer' },
      { circle_id: CIRCLE_B, user_id: OWNER_B, role: 'owner' },
    ];
    const pg = fakePostgrest(doses, members);
    const pushes: PushPayload[] = [];
    const handler = createMarkMissedHandler({
      cronSecret: 'cron-secret-store-run',
      now: () => new Date('2026-11-15T12:00:00.000Z'),
      store: createMarkMissedPostgrestStore(SUPABASE_URL, SERVICE_KEY, pg.fetchImpl),
      sendPush: (payload) => {
        pushes.push(structuredClone(payload));
        return Promise.resolve({ ok: true, sent: payload.userIds.length });
      },
    });
    const run = () =>
      handler(
        new Request('http://localhost/functions/v1/mark-missed', {
          method: 'POST',
          headers: { authorization: 'Bearer cron-secret-store-run' },
        }),
      );

    const res = await run();
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(
      doses.map((d) => d.status).join(',') === 'missed,missed,pending,given',
      `expected missed,missed,pending,given, got ${doses.map((d) => d.status).join(',')}`,
    );
    assert(
      doses[0]!.acted_by === null && doses[1]!.acted_by === null,
      'missed doses have acted_by = null',
    );
    assert(pushes.length === 2, `expected 2 pushes, got ${pushes.length}`);
    const forA = pushes.find((p) => p.data.doseEventId === doseId(1));
    const forB = pushes.find((p) => p.data.doseEventId === doseId(2));
    assert(
      forA &&
        JSON.stringify([...forA.userIds].sort()) === JSON.stringify([OWNER_A, HELPER_A1].sort()),
      `circle A dose goes to A's owner and helper only, got ${JSON.stringify(forA)}`,
    );
    assert(
      forB && JSON.stringify(forB.userIds) === JSON.stringify([OWNER_B]),
      `circle B dose goes to B's owner only, got ${JSON.stringify(forB)}`,
    );

    const res2 = await run();
    assert(res2.status === 200, `second run: expected 200, got ${res2.status}`);
    assert(pushes.length === 2, `second run sends no new push, got ${pushes.length} in total`);
  },
);

Deno.test(
  'send-push call: POSTs the payload to /functions/v1/send-push with the service-role key, and reports a refusal as ok: false',
  async () => {
    const { createSendPushViaFunction } = await loadStoreModule();
    const pg = fakePostgrest([], []);
    const sendPush = createSendPushViaFunction(`${SUPABASE_URL}/`, SERVICE_KEY, pg.fetchImpl);
    const payload: PushPayload = {
      userIds: [OWNER_A, HELPER_A1],
      title: 'A dose was missed',
      body: 'Open CareCircle to check.',
      data: {
        type: 'missed_dose',
        circleId: CIRCLE_A,
        doseEventId: doseId(1),
        medicationId: MED_A,
      },
    };

    pg.setPushResponse(() => Response.json({ ok: true, sent: 2, pruned: 0 }));
    const ok = await sendPush(payload);
    assert(ok.ok === true, `expected ok: true, got ${JSON.stringify(ok)}`);
    assert(pg.pushRequests.length === 1, 'one request to send-push');
    const sent = pg.pushRequests[0]!;
    assert(
      sent.headers.get('authorization') === `Bearer ${SERVICE_KEY}`,
      'send-push is called with the service-role key',
    );
    assert(
      JSON.stringify(sent.body) === JSON.stringify(payload),
      `the payload is sent unchanged, got ${JSON.stringify(sent.body)}`,
    );
    assert(
      pg.requests.some((r) => r.method === 'POST' && r.path === '/functions/v1/send-push'),
      'the request goes to /functions/v1/send-push',
    );

    for (const status of [400, 401, 502, 503]) {
      pg.setPushResponse(() =>
        Response.json({ ok: false, error: { code: 'PROVIDER_ERROR' } }, { status }),
      );
      const refused = await sendPush(payload);
      assert(refused.ok === false, `send-push answering ${status} is reported as ok: false`);
    }
  },
);

Deno.test(
  'store: a PostgREST error is thrown, never turned into an empty list, "not updated" or "no recipients"',
  async () => {
    const { createMarkMissedPostgrestStore } = await loadStoreModule();
    const doses = [dose(doseId(1), '2026-11-15T10:00:00.000Z', 'pending')];
    const members: MemberRow[] = [{ circle_id: CIRCLE_A, user_id: OWNER_A, role: 'owner' }];
    const pg = fakePostgrest(doses, members);
    const store = createMarkMissedPostgrestStore(SUPABASE_URL, SERVICE_KEY, pg.fetchImpl);

    for (const status of [401, 500, 503]) {
      pg.setRestStatus(status);
      const calls: Array<[string, () => Promise<unknown>]> = [
        ['listOverduePendingDoses', () => store.listOverduePendingDoses(CUTOFF)],
        ['markDoseMissedIfPending', () => store.markDoseMissedIfPending(doseId(1))],
        ['listCircleOwnerAndHelperUserIds', () => store.listCircleOwnerAndHelperUserIds(CIRCLE_A)],
      ];
      for (const [name, call] of calls) {
        let threw = false;
        try {
          await call();
        } catch {
          threw = true;
        }
        assert(threw, `${name} must throw when PostgREST answers HTTP ${status}`);
      }
    }
    pg.setRestStatus(200);
    assert(doses[0]!.status === 'pending', 'nothing was changed while PostgREST was failing');
  },
);
