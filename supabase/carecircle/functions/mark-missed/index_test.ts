// CC-2b [safety 1/2]: Edge Function `mark-missed` (spec Part 2 > Dose engine rule 3).
// Scheduled every 5 minutes (`*/5 * * * *`) via pg_cron + pg_net using `project_url` and
// `cron_secret` in Supabase Vault.
//
// Proposed implementation files for CC-2b [safety 2/2]:
// - `supabase/carecircle/functions/mark-missed/handler.ts`:
//   exports `MISSED_THRESHOLD_MINUTES = 60` and `createMarkMissedHandler(deps: MarkMissedHandlerDeps)`
// - `supabase/carecircle/functions/mark-missed/store.ts`:
//   exports `createMarkMissedPostgrestStore(supabaseUrl: string, serviceRoleKey: string)`
// - `supabase/carecircle/functions/mark-missed/index.ts`:
//   `Deno.serve(...)` wiring `CRON_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `send-push`.

import { createSendPushHandler } from '../send-push/handler.ts';

interface OverdueDoseRow {
  id: string;
  medication_id: string;
  circle_id: string;
  due_at: string;
  status: 'pending' | 'given' | 'skipped' | 'missed';
  acted_by: string | null;
  acted_at: string | null;
}

interface CircleMemberRoleRow {
  circle_id: string;
  user_id: string;
  role: 'owner' | 'helper' | 'viewer';
}

interface MarkMissedStore {
  /**
   * Returns `pending` doses with `due_at <= cutoffIso` (paged so >1000 rows are not truncated).
   */
  listOverduePendingDoses(cutoffIso: string): Promise<OverdueDoseRow[]>;
  /**
   * Atomically transitions a dose from `pending` to `missed` (`where id = $1 and status = 'pending'`),
   * leaving `acted_by = null` and `acted_at = null`. Returns `{ updated: true }` only when the row
   * actually changed from `pending` to `missed`.
   */
  markDoseMissedIfPending(doseEventId: string): Promise<{ updated: boolean }>;
  /**
   * Returns the `user_id`s of members in `circleId` whose role is `'owner'` or `'helper'`
   * (never `'viewer'`).
   */
  listCircleOwnerAndHelperUserIds(circleId: string): Promise<string[]>;
}

interface MarkMissedPushPayload {
  userIds: string[];
  title: string;
  body: string;
  data: {
    type: 'missed_dose';
    circleId: string;
    doseEventId: string;
    medicationId: string;
  };
}

interface MarkMissedHandlerDeps {
  cronSecret?: string;
  now?: () => Date;
  store: MarkMissedStore;
  sendPush: (payload: MarkMissedPushPayload) => Promise<{ ok: boolean; sent?: number }>;
}

interface MarkMissedModule {
  MISSED_THRESHOLD_MINUTES: number;
  createMarkMissedHandler: (deps: MarkMissedHandlerDeps) => (req: Request) => Promise<Response>;
}

async function loadHandlerModule(): Promise<MarkMissedModule> {
  const modPath = './handler.ts';
  return (await import(modPath)) as MarkMissedModule;
}

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
};

const CRON_SECRET = 'cron-secret-0123456789abcdef0123456789abcdef';
const SERVICE_KEY = 'service-role-key-0123456789abcdef';

const CIRCLE_A = 'c2bc0001-0000-4000-8000-000000000001';
const CIRCLE_B = 'c2bc0002-0000-4000-8000-000000000002';

const MED_A = 'c2b20001-0000-4000-8000-000000000001';
const MED_B = 'c2b20002-0000-4000-8000-000000000002';

const OWNER_A = 'c2b00001-0000-4000-8000-000000000001';
const HELPER_A1 = 'c2b00002-0000-4000-8000-000000000002';
const HELPER_A2 = 'c2b00003-0000-4000-8000-000000000003';
const VIEWER_A = 'c2b00004-0000-4000-8000-000000000004';
const OWNER_B = 'c2b00005-0000-4000-8000-000000000005';
const HELPER_B = 'c2b00006-0000-4000-8000-000000000006';
const OUTSIDER = 'c2b00007-0000-4000-8000-000000000007';

const DOSE_EXACT_60M = 'c2b30001-0000-4000-8000-000000000001';
const DOSE_90M_AGO = 'c2b30002-0000-4000-8000-000000000002';
const DOSE_59M59S_AGO = 'c2b30003-0000-4000-8000-000000000003';
const DOSE_59M_AGO = 'c2b30004-0000-4000-8000-000000000004';
const DOSE_FUTURE = 'c2b30005-0000-4000-8000-000000000005';
const DOSE_GIVEN_OLD = 'c2b30006-0000-4000-8000-000000000006';
const DOSE_SKIPPED_OLD = 'c2b30007-0000-4000-8000-000000000007';
const DOSE_ALREADY_MISSED = 'c2b30008-0000-4000-8000-000000000008';

function createFakeEnvironment(initialDoses: OverdueDoseRow[], members: CircleMemberRoleRow[]) {
  const doses: OverdueDoseRow[] = initialDoses.map((d) => ({ ...d }));
  const pushCalls: MarkMissedPushPayload[] = [];

  const store: MarkMissedStore = {
    async listOverduePendingDoses(cutoffIso: string) {
      const cutoffMs = Date.parse(cutoffIso);
      // Intentionally return all doses with due_at <= cutoffMs if the store is naive,
      // or pending ones; the handler + store must ensure only status === 'pending' and due_at <= now - 60m are marked.
      return doses
        .filter((d) => d.status === 'pending' && Date.parse(d.due_at) <= cutoffMs)
        .map((d) => ({ ...d }));
    },
    async markDoseMissedIfPending(doseEventId: string) {
      const target = doses.find((d) => d.id === doseEventId);
      if (!target || target.status !== 'pending') {
        return { updated: false };
      }
      target.status = 'missed';
      return { updated: true };
    },
    async listCircleOwnerAndHelperUserIds(circleId: string) {
      return members
        .filter((m) => m.circle_id === circleId && (m.role === 'owner' || m.role === 'helper'))
        .map((m) => m.user_id);
    },
  };

  const sendPush = async (payload: MarkMissedPushPayload) => {
    pushCalls.push(structuredClone(payload));
    return { ok: true, sent: payload.userIds.length };
  };

  return { doses, pushCalls, store, sendPush };
}

function cronPostRequest(headers?: Record<string, string>): Request {
  return new Request('http://localhost/functions/v1/mark-missed', {
    method: 'POST',
    headers: headers ?? { authorization: `Bearer ${CRON_SECRET}` },
  });
}

Deno.test(
  'mark-missed rejects non-POST methods (405), missing/wrong CRON_SECRET (401), and fails closed (500) when unconfigured',
  async () => {
    const { createMarkMissedHandler } = await loadHandlerModule();
    const { store, sendPush } = createFakeEnvironment([], []);

    const unconfigured = createMarkMissedHandler({ cronSecret: '', store, sendPush });
    const res500 = await unconfigured(cronPostRequest());
    assert(res500.status === 500, `expected 500 when CRON_SECRET is empty, got ${res500.status}`);

    const handler = createMarkMissedHandler({ cronSecret: CRON_SECRET, store, sendPush });

    for (const method of ['GET', 'PUT', 'DELETE']) {
      const res405 = await handler(
        new Request('http://localhost/functions/v1/mark-missed', {
          method,
          headers: { authorization: `Bearer ${CRON_SECRET}` },
        }),
      );
      assert(res405.status === 405, `expected 405 for ${method}, got ${res405.status}`);
    }

    const badHeaders: Array<Record<string, string>> = [
      {},
      { authorization: 'Bearer wrong-secret' },
      { authorization: `Bearer ${CRON_SECRET.slice(0, -1)}` },
      { authorization: `Bearer ${CRON_SECRET}x` },
      { authorization: CRON_SECRET },
      { 'x-cron-secret': CRON_SECRET },
    ];
    for (const headers of badHeaders) {
      const res401 = await handler(cronPostRequest(headers));
      assert(res401.status === 401, `expected 401 for bad auth header, got ${res401.status}`);
    }
  },
);

Deno.test(
  'mark-missed marks pending doses with due_at <= now - 60m as missed (acted_by null), leaves 59m-ago, given, skipped, and already-missed doses untouched, and sends no duplicate push on re-run',
  async () => {
    const { createMarkMissedHandler, MISSED_THRESHOLD_MINUTES } = await loadHandlerModule();
    assert(
      MISSED_THRESHOLD_MINUTES === 60,
      `expected MISSED_THRESHOLD_MINUTES === 60, got ${MISSED_THRESHOLD_MINUTES}`,
    );

    const now = new Date('2026-11-15T12:00:00.000Z');
    const initialDoses: OverdueDoseRow[] = [
      // Exactly 60 minutes ago (11:00:00Z) -> MUST become 'missed'
      {
        id: DOSE_EXACT_60M,
        medication_id: MED_A,
        circle_id: CIRCLE_A,
        due_at: '2026-11-15T11:00:00.000Z',
        status: 'pending',
        acted_by: null,
        acted_at: null,
      },
      // 90 minutes ago (10:30:00Z) -> MUST become 'missed'
      {
        id: DOSE_90M_AGO,
        medication_id: MED_A,
        circle_id: CIRCLE_A,
        due_at: '2026-11-15T10:30:00.000Z',
        status: 'pending',
        acted_by: null,
        acted_at: null,
      },
      // 59 minutes 59 seconds ago (11:00:01Z) -> MUST stay 'pending'
      {
        id: DOSE_59M59S_AGO,
        medication_id: MED_A,
        circle_id: CIRCLE_A,
        due_at: '2026-11-15T11:00:01.000Z',
        status: 'pending',
        acted_by: null,
        acted_at: null,
      },
      // 59 minutes ago (11:01:00Z) -> MUST stay 'pending'
      {
        id: DOSE_59M_AGO,
        medication_id: MED_A,
        circle_id: CIRCLE_A,
        due_at: '2026-11-15T11:01:00.000Z',
        status: 'pending',
        acted_by: null,
        acted_at: null,
      },
      // Future dose (14:00:00Z) -> MUST stay 'pending'
      {
        id: DOSE_FUTURE,
        medication_id: MED_A,
        circle_id: CIRCLE_A,
        due_at: '2026-11-15T14:00:00.000Z',
        status: 'pending',
        acted_by: null,
        acted_at: null,
      },
      // Old given dose (08:00:00Z) -> MUST stay 'given' with acted_by and acted_at intact
      {
        id: DOSE_GIVEN_OLD,
        medication_id: MED_A,
        circle_id: CIRCLE_A,
        due_at: '2026-11-15T08:00:00.000Z',
        status: 'given',
        acted_by: HELPER_A1,
        acted_at: '2026-11-15T08:03:00.000Z',
      },
      // Old skipped dose (09:00:00Z) -> MUST stay 'skipped' with acted_by and acted_at intact
      {
        id: DOSE_SKIPPED_OLD,
        medication_id: MED_A,
        circle_id: CIRCLE_A,
        due_at: '2026-11-15T09:00:00.000Z',
        status: 'skipped',
        acted_by: OWNER_A,
        acted_at: '2026-11-15T09:05:00.000Z',
      },
      // Already missed dose (07:00:00Z) -> MUST NOT trigger another push
      {
        id: DOSE_ALREADY_MISSED,
        medication_id: MED_A,
        circle_id: CIRCLE_A,
        due_at: '2026-11-15T07:00:00.000Z',
        status: 'missed',
        acted_by: null,
        acted_at: null,
      },
    ];

    const members: CircleMemberRoleRow[] = [
      { circle_id: CIRCLE_A, user_id: OWNER_A, role: 'owner' },
      { circle_id: CIRCLE_A, user_id: HELPER_A1, role: 'helper' },
      { circle_id: CIRCLE_A, user_id: VIEWER_A, role: 'viewer' },
    ];

    const { doses, pushCalls, store, sendPush } = createFakeEnvironment(initialDoses, members);
    const handler = createMarkMissedHandler({
      cronSecret: CRON_SECRET,
      now: () => now,
      store,
      sendPush,
    });

    // First run
    const res1 = await handler(cronPostRequest());
    assert(res1.status === 200, `expected 200 on first run, got ${res1.status}`);
    const body1 = (await res1.json()) as { ok: boolean; missed: number };
    assert(
      body1.ok === true && body1.missed === 2,
      `expected { ok: true, missed: 2 }, got ${JSON.stringify(body1)}`,
    );

    const byId = (id: string) => doses.find((d) => d.id === id)!;
    assert(
      byId(DOSE_EXACT_60M).status === 'missed' &&
        byId(DOSE_EXACT_60M).acted_by === null &&
        byId(DOSE_EXACT_60M).acted_at === null,
      'dose due_at === now - 60m must become missed with acted_by = null and acted_at = null',
    );
    assert(
      byId(DOSE_90M_AGO).status === 'missed' &&
        byId(DOSE_90M_AGO).acted_by === null &&
        byId(DOSE_90M_AGO).acted_at === null,
      'dose due_at === now - 90m must become missed with acted_by = null and acted_at = null',
    );
    assert(byId(DOSE_59M59S_AGO).status === 'pending', 'dose 59m59s ago must stay pending');
    assert(byId(DOSE_59M_AGO).status === 'pending', 'dose 59m ago must stay pending');
    assert(byId(DOSE_FUTURE).status === 'pending', 'future dose must stay pending');
    assert(
      byId(DOSE_GIVEN_OLD).status === 'given' && byId(DOSE_GIVEN_OLD).acted_by === HELPER_A1,
      'given dose must never be touched',
    );
    assert(
      byId(DOSE_SKIPPED_OLD).status === 'skipped' && byId(DOSE_SKIPPED_OLD).acted_by === OWNER_A,
      'skipped dose must never be touched',
    );

    // Exactly 2 push calls (one for DOSE_EXACT_60M and one for DOSE_90M_AGO; none for DOSE_ALREADY_MISSED)
    assert(pushCalls.length === 2, `expected 2 push calls, got ${pushCalls.length}`);
    const pushedDoseIds = pushCalls.map((c) => c.data.doseEventId).sort();
    assert(
      JSON.stringify(pushedDoseIds) === JSON.stringify([DOSE_EXACT_60M, DOSE_90M_AGO].sort()),
      `expected pushes only for newly missed doses, got ${JSON.stringify(pushedDoseIds)}`,
    );

    // Second run right away: 0 newly missed doses, 0 additional pushes
    const res2 = await handler(cronPostRequest());
    assert(res2.status === 200, `expected 200 on second run, got ${res2.status}`);
    const body2 = (await res2.json()) as { ok: boolean; missed: number };
    assert(
      body2.ok === true && body2.missed === 0,
      `second run must mark 0 doses, got ${JSON.stringify(body2)}`,
    );
    assert(pushCalls.length === 2, `second run must send 0 new pushes, got ${pushCalls.length}`);
  },
);

Deno.test(
  'mark-missed sends push to the circle owner and every helper (deduplicated, never viewers or outsiders) with a neutral payload accepted by send-push',
  async () => {
    const { createMarkMissedHandler } = await loadHandlerModule();
    const now = new Date('2026-11-15T12:00:00.000Z');

    const initialDoses: OverdueDoseRow[] = [
      {
        id: DOSE_EXACT_60M,
        medication_id: MED_A,
        circle_id: CIRCLE_A,
        due_at: '2026-11-15T11:00:00.000Z',
        status: 'pending',
        acted_by: null,
        acted_at: null,
      },
    ];

    // Circle A has 1 owner, 2 helpers (with HELPER_A1 duplicated to verify deduplication), 1 viewer;
    // Circle B has OWNER_B and HELPER_B; OUTSIDER belongs to no circle.
    const members: CircleMemberRoleRow[] = [
      { circle_id: CIRCLE_A, user_id: OWNER_A, role: 'owner' },
      { circle_id: CIRCLE_A, user_id: HELPER_A1, role: 'helper' },
      { circle_id: CIRCLE_A, user_id: HELPER_A1, role: 'helper' },
      { circle_id: CIRCLE_A, user_id: HELPER_A2, role: 'helper' },
      { circle_id: CIRCLE_A, user_id: VIEWER_A, role: 'viewer' },
      { circle_id: CIRCLE_B, user_id: OWNER_B, role: 'owner' },
      { circle_id: CIRCLE_B, user_id: HELPER_B, role: 'helper' },
    ];

    const { store } = createFakeEnvironment(initialDoses, members);
    const expoRequests: Array<
      Array<{ to: string; title: string; body: string; data?: Record<string, string> }>
    > = [];
    const sendPushHandler = createSendPushHandler({
      getEnv: (k) => (k === 'SUPABASE_SERVICE_ROLE_KEY' ? SERVICE_KEY : undefined),
      loadTokens: async (userIds) =>
        userIds.map((uid, idx) => ({
          user_id: uid,
          token: `ExponentPushToken[token-${idx}-${uid.slice(-4)}]`,
          platform: 'ios' as const,
        })),
      pruneTokens: async () => undefined,
      fetchImpl: async (_input, init) => {
        const parsed = JSON.parse(String(init?.body ?? '[]'));
        expoRequests.push(parsed);
        return new Response(JSON.stringify({ data: parsed.map(() => ({ status: 'ok' })) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const recordedPayloads: MarkMissedPushPayload[] = [];
    const handler = createMarkMissedHandler({
      cronSecret: CRON_SECRET,
      now: () => now,
      store,
      sendPush: async (payload) => {
        recordedPayloads.push(structuredClone(payload));
        const res = await sendPushHandler(
          new Request('http://localhost/functions/v1/send-push', {
            method: 'POST',
            headers: {
              authorization: `Bearer ${SERVICE_KEY}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(payload),
          }),
        );
        const body = (await res.json()) as { ok: boolean; sent?: number };
        assert(
          res.status === 200 && body.ok === true,
          `send-push rejected mark-missed payload (${res.status}): ${JSON.stringify(body)}`,
        );
        return body;
      },
    });

    const res = await handler(cronPostRequest());
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(recordedPayloads.length === 1, `expected 1 push call, got ${recordedPayloads.length}`);

    const recipients = [...recordedPayloads[0]!.userIds].sort();
    const expectedRecipients = [OWNER_A, HELPER_A1, HELPER_A2].sort();
    assert(
      JSON.stringify(recipients) === JSON.stringify(expectedRecipients),
      `expected owner + every helper of Circle A once each (${JSON.stringify(expectedRecipients)}), got ${JSON.stringify(recipients)}`,
    );
    assert(!recipients.includes(VIEWER_A), 'viewer must never receive missed-dose push');
    assert(!recipients.includes(OWNER_B), 'other circle owner must never receive push');
    assert(!recipients.includes(OUTSIDER), 'outsider must never receive push');
    assert(
      expoRequests.length === 1 && expoRequests[0]!.length === 3,
      'expected 3 Expo push messages',
    );
  },
);

Deno.test(
  'mark-missed sends no push if the dose was concurrently checked off before markDoseMissedIfPending',
  async () => {
    const { createMarkMissedHandler } = await loadHandlerModule();
    const now = new Date('2026-11-15T12:00:00.000Z');

    const initialDoses: OverdueDoseRow[] = [
      {
        id: DOSE_EXACT_60M,
        medication_id: MED_A,
        circle_id: CIRCLE_A,
        due_at: '2026-11-15T11:00:00.000Z',
        status: 'pending',
        acted_by: null,
        acted_at: null,
      },
    ];
    const members: CircleMemberRoleRow[] = [
      { circle_id: CIRCLE_A, user_id: OWNER_A, role: 'owner' },
    ];
    const { pushCalls, store, sendPush } = createFakeEnvironment(initialDoses, members);
    const raceLostStore: MarkMissedStore = {
      ...store,
      async markDoseMissedIfPending() {
        // Another carer marked it given right before our update
        return { updated: false };
      },
    };

    const handler = createMarkMissedHandler({
      cronSecret: CRON_SECRET,
      now: () => now,
      store: raceLostStore,
      sendPush,
    });

    const res = await handler(cronPostRequest());
    const body = (await res.json()) as { ok: boolean; missed: number };
    assert(
      res.status === 200 && body.ok === true && body.missed === 0,
      'expected missed: 0 when update race lost',
    );
    assert(
      pushCalls.length === 0,
      'must send 0 pushes when markDoseMissedIfPending returns updated: false',
    );
  },
);

Deno.test(
  'one failing circle does not stop other circles from being marked missed and notified, and the run answers 500 with ok: false',
  async () => {
    const { createMarkMissedHandler } = await loadHandlerModule();
    const now = new Date('2026-11-15T12:00:00.000Z');

    const doseCircleA = DOSE_EXACT_60M;
    const doseCircleB = 'c2b30009-0000-4000-8000-000000000009';

    const initialDoses: OverdueDoseRow[] = [
      {
        id: doseCircleA,
        medication_id: MED_A,
        circle_id: CIRCLE_A,
        due_at: '2026-11-15T10:45:00.000Z',
        status: 'pending',
        acted_by: null,
        acted_at: null,
      },
      {
        id: doseCircleB,
        medication_id: MED_B,
        circle_id: CIRCLE_B,
        due_at: '2026-11-15T10:50:00.000Z',
        status: 'pending',
        acted_by: null,
        acted_at: null,
      },
    ];
    const members: CircleMemberRoleRow[] = [
      { circle_id: CIRCLE_A, user_id: OWNER_A, role: 'owner' },
      { circle_id: CIRCLE_B, user_id: OWNER_B, role: 'owner' },
      { circle_id: CIRCLE_B, user_id: HELPER_B, role: 'helper' },
    ];

    const { doses, pushCalls, store, sendPush } = createFakeEnvironment(initialDoses, members);
    const partialFailStore: MarkMissedStore = {
      ...store,
      async listCircleOwnerAndHelperUserIds(circleId: string) {
        if (circleId === CIRCLE_A) {
          throw new Error('Circle A member lookup failed');
        }
        return store.listCircleOwnerAndHelperUserIds(circleId);
      },
    };

    const handler = createMarkMissedHandler({
      cronSecret: CRON_SECRET,
      now: () => now,
      store: partialFailStore,
      sendPush,
    });

    const res = await handler(cronPostRequest());
    const body = (await res.json()) as { ok: boolean; missed: number; failed: number };
    assert(res.status === 500, `expected 500 on partial failure, got ${res.status}`);
    assert(
      body.ok === false && body.failed >= 1,
      `expected ok: false and failed >= 1, got ${JSON.stringify(body)}`,
    );

    // Circle B's dose was still marked missed and Circle B's owner + helper still received their push
    const doseB = doses.find((d) => d.id === doseCircleB)!;
    assert(doseB.status === 'missed', 'Circle B overdue dose must still be marked missed');
    assert(
      pushCalls.length === 1 &&
        pushCalls[0]!.data.circleId === CIRCLE_B &&
        JSON.stringify([...pushCalls[0]!.userIds].sort()) ===
          JSON.stringify([OWNER_B, HELPER_B].sort()),
      `Circle B owner and helper must still get push, got ${JSON.stringify(pushCalls)}`,
    );
  },
);

// ---------------------------------------------------------------------------------------------
// Review additions (Claude): failures at every step are reported, never hidden, and every push
// carries exactly the ids of its own dose.

function overdueDose(id: string, circleId: string, medicationId: string): OverdueDoseRow {
  return {
    id,
    medication_id: medicationId,
    circle_id: circleId,
    due_at: '2026-11-15T10:30:00.000Z',
    status: 'pending',
    acted_by: null,
    acted_at: null,
  };
}

const TWO_CIRCLE_MEMBERS: CircleMemberRoleRow[] = [
  { circle_id: CIRCLE_A, user_id: OWNER_A, role: 'owner' },
  { circle_id: CIRCLE_A, user_id: HELPER_A1, role: 'helper' },
  { circle_id: CIRCLE_A, user_id: VIEWER_A, role: 'viewer' },
  { circle_id: CIRCLE_B, user_id: OWNER_B, role: 'owner' },
  { circle_id: CIRCLE_B, user_id: HELPER_B, role: 'helper' },
];

const DOSE_A2 = 'c2b3000a-0000-4000-8000-00000000000a';
const DOSE_B1 = 'c2b3000b-0000-4000-8000-00000000000b';

Deno.test(
  'each push carries exactly its own dose (type, circleId, doseEventId, medicationId), goes only to that circle, and has the same neutral title and body',
  async () => {
    const { createMarkMissedHandler } = await loadHandlerModule();
    const { pushCalls, store, sendPush } = createFakeEnvironment(
      [
        overdueDose(DOSE_EXACT_60M, CIRCLE_A, MED_A),
        overdueDose(DOSE_A2, CIRCLE_A, MED_B),
        overdueDose(DOSE_B1, CIRCLE_B, MED_B),
      ],
      TWO_CIRCLE_MEMBERS,
    );
    const handler = createMarkMissedHandler({
      cronSecret: CRON_SECRET,
      now: () => new Date('2026-11-15T12:00:00.000Z'),
      store,
      sendPush,
    });

    const res = await handler(cronPostRequest());
    const body = (await res.json()) as { ok: boolean; missed: number };
    assert(res.status === 200 && body.ok === true && body.missed === 3, JSON.stringify(body));
    assert(
      pushCalls.length === 3,
      `expected one push per missed dose (3), got ${pushCalls.length}`,
    );

    const expected: Record<string, { circleId: string; medicationId: string; users: string[] }> = {
      [DOSE_EXACT_60M]: { circleId: CIRCLE_A, medicationId: MED_A, users: [OWNER_A, HELPER_A1] },
      [DOSE_A2]: { circleId: CIRCLE_A, medicationId: MED_B, users: [OWNER_A, HELPER_A1] },
      [DOSE_B1]: { circleId: CIRCLE_B, medicationId: MED_B, users: [OWNER_B, HELPER_B] },
    };
    for (const call of pushCalls) {
      const want = expected[call.data.doseEventId];
      assert(want !== undefined, `unexpected push for ${call.data.doseEventId}`);
      assert(
        JSON.stringify(call.data) ===
          JSON.stringify({
            type: 'missed_dose',
            circleId: want.circleId,
            doseEventId: call.data.doseEventId,
            medicationId: want.medicationId,
          }),
        `push data must be exactly { type, circleId, doseEventId, medicationId } of its dose, got ${JSON.stringify(call.data)}`,
      );
      assert(
        JSON.stringify([...call.userIds].sort()) === JSON.stringify([...want.users].sort()),
        `push for ${call.data.doseEventId} must go to its own circle's owner and helpers, got ${JSON.stringify(call.userIds)}`,
      );
      assert(
        call.title.trim().length > 0 && call.body.trim().length > 0,
        'title and body are not empty',
      );
      for (const id of [call.data.circleId, call.data.doseEventId, call.data.medicationId]) {
        assert(
          !call.title.includes(id) && !call.body.includes(id),
          'title and body contain no ids',
        );
      }
    }
    assert(
      new Set(pushCalls.map((c) => `${c.title}\u0000${c.body}`)).size === 1,
      'every missed-dose push has the same fixed title and body (nothing about the medicine)',
    );
  },
);

Deno.test(
  'a push that send-push refuses (ok: false) or that throws is counted as a failure: the run answers 500 with ok: false and still handles the other doses',
  async () => {
    const { createMarkMissedHandler } = await loadHandlerModule();
    for (const mode of ['refused', 'throws'] as const) {
      const { doses, store } = createFakeEnvironment(
        [overdueDose(DOSE_EXACT_60M, CIRCLE_A, MED_A), overdueDose(DOSE_B1, CIRCLE_B, MED_B)],
        TWO_CIRCLE_MEMBERS,
      );
      const delivered: string[] = [];
      const handler = createMarkMissedHandler({
        cronSecret: CRON_SECRET,
        now: () => new Date('2026-11-15T12:00:00.000Z'),
        store,
        sendPush: (payload) => {
          if (payload.data.circleId === CIRCLE_A) {
            if (mode === 'throws') return Promise.reject(new Error('network down'));
            return Promise.resolve({ ok: false });
          }
          delivered.push(payload.data.doseEventId);
          return Promise.resolve({ ok: true, sent: payload.userIds.length });
        },
      });

      const res = await handler(cronPostRequest());
      const body = (await res.json()) as { ok: boolean; failed: number };
      assert(res.status === 500, `${mode}: expected 500, got ${res.status}`);
      assert(
        body.ok === false && body.failed >= 1,
        `${mode}: expected ok: false and failed >= 1, got ${JSON.stringify(body)}`,
      );
      assert(
        JSON.stringify(delivered) === JSON.stringify([DOSE_B1]),
        `${mode}: circle B's push is still sent, got ${JSON.stringify(delivered)}`,
      );
      assert(
        doses.every((d) => d.status === 'missed'),
        `${mode}: both doses are marked missed`,
      );
    }
  },
);

Deno.test(
  'a dose whose update fails is a failure (500, ok: false) and does not stop the other doses',
  async () => {
    const { createMarkMissedHandler } = await loadHandlerModule();
    const { doses, pushCalls, store, sendPush } = createFakeEnvironment(
      [overdueDose(DOSE_EXACT_60M, CIRCLE_A, MED_A), overdueDose(DOSE_B1, CIRCLE_B, MED_B)],
      TWO_CIRCLE_MEMBERS,
    );
    const failingStore: MarkMissedStore = {
      ...store,
      markDoseMissedIfPending(doseEventId: string) {
        if (doseEventId === DOSE_EXACT_60M) return Promise.reject(new Error('HTTP 503'));
        return store.markDoseMissedIfPending(doseEventId);
      },
    };
    const handler = createMarkMissedHandler({
      cronSecret: CRON_SECRET,
      now: () => new Date('2026-11-15T12:00:00.000Z'),
      store: failingStore,
      sendPush,
    });

    const res = await handler(cronPostRequest());
    const body = (await res.json()) as { ok: boolean; failed: number };
    assert(res.status === 500 && body.ok === false && body.failed >= 1, JSON.stringify(body));
    assert(doses[0]!.status === 'pending', 'the dose whose update failed stays pending');
    assert(doses[1]!.status === 'missed', 'the other dose is still marked missed');
    assert(
      pushCalls.length === 1 && pushCalls[0]!.data.doseEventId === DOSE_B1,
      `only the dose that was marked is pushed, got ${JSON.stringify(pushCalls.map((c) => c.data.doseEventId))}`,
    );
  },
);

Deno.test(
  'when the overdue list cannot be read, the run answers 500 with ok: false and pushes nothing',
  async () => {
    const { createMarkMissedHandler } = await loadHandlerModule();
    const { pushCalls, store, sendPush } = createFakeEnvironment([], TWO_CIRCLE_MEMBERS);
    const handler = createMarkMissedHandler({
      cronSecret: CRON_SECRET,
      now: () => new Date('2026-11-15T12:00:00.000Z'),
      store: { ...store, listOverduePendingDoses: () => Promise.reject(new Error('HTTP 500')) },
      sendPush,
    });

    const res = await handler(cronPostRequest());
    assert(res.status === 500, `expected 500, got ${res.status}`);
    const body = (await res.json()) as { ok: boolean };
    assert(body.ok === false, `expected ok: false, got ${JSON.stringify(body)}`);
    assert(pushCalls.length === 0, 'no push is sent');
  },
);

Deno.test(
  'the cutoff passed to the store is exactly now - 60 minutes, as an ISO string',
  async () => {
    const { createMarkMissedHandler } = await loadHandlerModule();
    const { store, sendPush } = createFakeEnvironment([], []);
    const cutoffs: string[] = [];
    const handler = createMarkMissedHandler({
      cronSecret: CRON_SECRET,
      now: () => new Date('2026-11-15T12:00:00.000Z'),
      store: {
        ...store,
        listOverduePendingDoses: (cutoffIso: string) => {
          cutoffs.push(cutoffIso);
          return store.listOverduePendingDoses(cutoffIso);
        },
      },
      sendPush,
    });
    const res = await handler(cronPostRequest());
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(
      JSON.stringify(cutoffs) === JSON.stringify(['2026-11-15T11:00:00.000Z']),
      `expected one call with 2026-11-15T11:00:00.000Z, got ${JSON.stringify(cutoffs)}`,
    );
  },
);
