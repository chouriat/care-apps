// CC-2a [safety 1/2]: Edge Function `materialize-doses` (spec Part 2 > Dose engine rules 1, 2, 4, 5).
// Scheduled hourly via pg_cron + pg_net using a shared secret in Supabase Vault
// (checked 2026-11-15 at https://supabase.com/docs/guides/functions/schedule-functions).

export interface ActiveMedicationWithTimezoneRow {
  id: string;
  circle_id: string;
  schedule: Record<string, unknown>;
  start_date: string | null;
  end_date: string | null;
  active: boolean;
  circle_timezone: string;
}

export interface DoseEventInsertRow {
  medication_id: string;
  circle_id: string;
  due_at: string;
  status: 'pending' | 'given' | 'skipped' | 'missed';
  acted_by: string | null;
  acted_at: string | null;
}

export interface MaterializeDosesStore {
  listActiveMedications(): Promise<ActiveMedicationWithTimezoneRow[]>;
  insertPendingDoseEvents(rows: DoseEventInsertRow[]): Promise<{ inserted: number }>;
  deleteFuturePendingDoseEventsForMedication?(
    medicationId: string,
    afterIso: string,
  ): Promise<{ deleted: number }>;
}

export interface MaterializeDosesHandlerDeps {
  cronSecret?: string;
  now?: () => Date;
  store: MaterializeDosesStore;
}

interface MaterializeDosesModule {
  HORIZON_HOURS: number;
  createMaterializeDosesHandler: (
    deps: MaterializeDosesHandlerDeps,
  ) => (req: Request) => Promise<Response>;
  reconcileMedicationScheduleEdit: (opts: {
    medication: ActiveMedicationWithTimezoneRow;
    now: Date;
    store: Required<MaterializeDosesStore>;
  }) => Promise<{ deletedPending: number; materialized: number }>;
}

async function loadHandlerModule(): Promise<MaterializeDosesModule> {
  const modPath = './handler.ts';
  return (await import(modPath)) as MaterializeDosesModule;
}

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
};

const CIRCLE_A = 'c1c00001-0000-4000-8000-000000000001';
const MED_DAILY = 'c1200001-0000-4000-8000-000000000001';
const MED_AS_NEEDED = 'c1200001-0000-4000-8000-000000000002';
const MED_OTHER = 'c1200001-0000-4000-8000-000000000003';
const CRON_SECRET = 'cron-secret-0123456789abcdef0123456789abcdef';

function createInMemoryStore(
  meds: ActiveMedicationWithTimezoneRow[],
  initialEvents: DoseEventInsertRow[] = [],
) {
  const events: DoseEventInsertRow[] = [...initialEvents];
  const store: Required<MaterializeDosesStore> = {
    async listActiveMedications() {
      return meds.filter((m) => m.active);
    },
    async insertPendingDoseEvents(rows) {
      let inserted = 0;
      for (const row of rows) {
        const exists = events.some(
          (e) => e.medication_id === row.medication_id && e.due_at === row.due_at,
        );
        if (!exists) {
          events.push({ ...row });
          inserted += 1;
        }
      }
      return { inserted };
    },
    async deleteFuturePendingDoseEventsForMedication(medicationId, afterIso) {
      const afterMs = Date.parse(afterIso);
      let deleted = 0;
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const ev = events[i];
        if (
          ev &&
          ev.medication_id === medicationId &&
          ev.status === 'pending' &&
          Date.parse(ev.due_at) > afterMs
        ) {
          events.splice(i, 1);
          deleted += 1;
        }
      }
      return { deleted };
    },
  };
  return { store, events };
}

Deno.test(
  'materialize-doses rejects missing or wrong cron secret and fails closed when unconfigured',
  async () => {
    const { createMaterializeDosesHandler } = await loadHandlerModule();
    const { store } = createInMemoryStore([]);

    const unconfigured = createMaterializeDosesHandler({ cronSecret: '', store });
    const res500 = await unconfigured(
      new Request('http://localhost/functions/v1/materialize-doses', { method: 'POST' }),
    );
    assert(res500.status === 500, `expected 500 when CRON_SECRET is missing, got ${res500.status}`);

    const handler = createMaterializeDosesHandler({ cronSecret: CRON_SECRET, store });
    const badHeaders: Array<Record<string, string>> = [
      {},
      { authorization: 'Bearer wrong-secret' },
      { authorization: `Bearer ${CRON_SECRET.slice(0, -1)}` },
      { 'x-cron-secret': 'wrong-secret' },
      // Added in review: the right secret with extra characters, and the secret without "Bearer ".
      { authorization: `Bearer ${CRON_SECRET}x` },
      { authorization: CRON_SECRET },
    ];
    for (const badHeader of badHeaders) {
      const res = await handler(
        new Request('http://localhost/functions/v1/materialize-doses', {
          method: 'POST',
          headers: badHeader,
        }),
      );
      assert(res.status === 401, `expected 401 for bad auth header, got ${res.status}`);
    }
  },
);

Deno.test(
  'running materialize-doses twice creates zero duplicates, caps at 48 hours, skips as_needed, and leaves acted_by null',
  async () => {
    const { createMaterializeDosesHandler, HORIZON_HOURS } = await loadHandlerModule();
    assert(HORIZON_HOURS === 48, `expected HORIZON_HOURS === 48, got ${HORIZON_HOURS}`);

    const now = new Date('2026-11-15T10:00:00.000Z');
    const meds: ActiveMedicationWithTimezoneRow[] = [
      {
        id: MED_DAILY,
        circle_id: CIRCLE_A,
        schedule: { kind: 'daily', times: ['08:00', '20:00'] },
        start_date: '2026-11-01',
        end_date: null,
        active: true,
        circle_timezone: 'Europe/London',
      },
      {
        id: MED_AS_NEEDED,
        circle_id: CIRCLE_A,
        schedule: { kind: 'as_needed' },
        start_date: '2026-11-01',
        end_date: null,
        active: true,
        circle_timezone: 'Europe/London',
      },
    ];

    // Seed one already-given event inside the 48h window to prove re-running never overwrites it.
    const existingGiven: DoseEventInsertRow = {
      medication_id: MED_DAILY,
      circle_id: CIRCLE_A,
      due_at: '2026-11-15T20:00:00.000Z',
      status: 'given',
      acted_by: 'c1000002-2222-4222-8222-222222222222',
      acted_at: '2026-11-15T19:55:00.000Z',
    };

    const { store, events } = createInMemoryStore(meds, [existingGiven]);
    const handler = createMaterializeDosesHandler({
      cronSecret: CRON_SECRET,
      now: () => now,
      store,
    });

    const invoke = () =>
      handler(
        new Request('http://localhost/functions/v1/materialize-doses', {
          method: 'POST',
          headers: { authorization: `Bearer ${CRON_SECRET}` },
        }),
      );

    const res1 = await invoke();
    assert(res1.status === 200, `first run must return 200, got ${res1.status}`);
    const body1 = (await res1.json()) as { ok: boolean; inserted: number };
    assert(
      body1.ok === true && body1.inserted === 3,
      `expected 3 new slots, got ${JSON.stringify(body1)}`,
    );

    // Second run at the same time creates 0 duplicates.
    const res2 = await invoke();
    const body2 = (await res2.json()) as { ok: boolean; inserted: number };
    assert(
      body2.ok === true && body2.inserted === 0,
      `second run must insert 0 duplicates, got ${JSON.stringify(body2)}`,
    );

    // Exactly 4 events exist for MED_DAILY in the 48h window, none for MED_AS_NEEDED.
    assert(events.length === 4, `expected 4 total events, got ${events.length}`);
    assert(
      events.every((e) => e.medication_id === MED_DAILY),
      'as_needed medication must produce 0 dose_events',
    );
    const maxMs = now.getTime() + 48 * 3_600_000;
    assert(
      events.every((e) => {
        const ms = Date.parse(e.due_at);
        return ms >= now.getTime() && ms <= maxMs;
      }),
      'all materialized events must fall within [now, now + 48 hours]',
    );

    // Server-created pending events have acted_by = null and acted_at = null; existing given event is untouched.
    const pendingEvents = events.filter((e) => e.due_at !== existingGiven.due_at);
    assert(
      pendingEvents.length === 3 &&
        pendingEvents.every(
          (e) => e.status === 'pending' && e.acted_by === null && e.acted_at === null,
        ),
      'newly materialized events must have status=pending, acted_by=null, acted_at=null',
    );
    const preservedGiven = events.find((e) => e.due_at === existingGiven.due_at);
    assert(
      preservedGiven?.status === 'given' && preservedGiven.acted_by === existingGiven.acted_by,
      'existing given event must not be overwritten',
    );
  },
);

Deno.test(
  'schedule edit deletes only future pending events of that medicine and re-materializes next 48h',
  async () => {
    const { reconcileMedicationScheduleEdit } = await loadHandlerModule();
    const now = new Date('2026-11-15T10:00:00.000Z');

    const initialEvents: DoseEventInsertRow[] = [
      // Past pending (must stay)
      {
        medication_id: MED_DAILY,
        circle_id: CIRCLE_A,
        due_at: '2026-11-15T08:00:00.000Z',
        status: 'pending',
        acted_by: null,
        acted_at: null,
      },
      // Past given (must stay)
      {
        medication_id: MED_DAILY,
        circle_id: CIRCLE_A,
        due_at: '2026-11-14T20:00:00.000Z',
        status: 'given',
        acted_by: 'c1000001-1111-4111-8111-111111111111',
        acted_at: '2026-11-14T20:02:00.000Z',
      },
      // Future given, skipped, missed (must stay)
      {
        medication_id: MED_DAILY,
        circle_id: CIRCLE_A,
        due_at: '2026-11-15T12:00:00.000Z',
        status: 'given',
        acted_by: 'c1000001-1111-4111-8111-111111111111',
        acted_at: '2026-11-15T09:50:00.000Z',
      },
      {
        medication_id: MED_DAILY,
        circle_id: CIRCLE_A,
        due_at: '2026-11-15T14:00:00.000Z',
        status: 'skipped',
        acted_by: 'c1000001-1111-4111-8111-111111111111',
        acted_at: '2026-11-15T09:55:00.000Z',
      },
      {
        medication_id: MED_DAILY,
        circle_id: CIRCLE_A,
        due_at: '2026-11-15T16:00:00.000Z',
        status: 'missed',
        acted_by: null,
        acted_at: null,
      },
      // Future pending on old schedule 20:00 (must be deleted)
      {
        medication_id: MED_DAILY,
        circle_id: CIRCLE_A,
        due_at: '2026-11-15T20:00:00.000Z',
        status: 'pending',
        acted_by: null,
        acted_at: null,
      },
      // Future pending on ANOTHER medication (must stay)
      {
        medication_id: MED_OTHER,
        circle_id: CIRCLE_A,
        due_at: '2026-11-15T20:00:00.000Z',
        status: 'pending',
        acted_by: null,
        acted_at: null,
      },
    ];

    const updatedMed: ActiveMedicationWithTimezoneRow = {
      id: MED_DAILY,
      circle_id: CIRCLE_A,
      schedule: { kind: 'daily', times: ['21:00'] },
      start_date: '2026-11-01',
      end_date: null,
      active: true,
      circle_timezone: 'Europe/London',
    };

    const { store, events } = createInMemoryStore([updatedMed], initialEvents);
    const result = await reconcileMedicationScheduleEdit({
      medication: updatedMed,
      now,
      store,
    });

    assert(
      result.deletedPending === 1,
      `expected 1 future pending deleted, got ${result.deletedPending}`,
    );
    assert(
      result.materialized === 2,
      `expected 2 new 21:00 slots materialized, got ${result.materialized}`,
    );

    // Old future pending 20:00 slot on MED_DAILY is gone, while MED_OTHER's 20:00 slot remains.
    assert(
      !events.some((e) => e.medication_id === MED_DAILY && e.due_at === '2026-11-15T20:00:00.000Z'),
      'future pending event on old schedule must be deleted',
    );
    assert(
      events.some((e) => e.medication_id === MED_OTHER && e.due_at === '2026-11-15T20:00:00.000Z'),
      'other medication future pending event must be untouched',
    );

    // Past pending, past given, future given, future skipped, future missed are all preserved.
    for (const keptDueAt of [
      '2026-11-15T08:00:00.000Z',
      '2026-11-14T20:00:00.000Z',
      '2026-11-15T12:00:00.000Z',
      '2026-11-15T14:00:00.000Z',
      '2026-11-15T16:00:00.000Z',
      '2026-11-15T21:00:00.000Z',
      '2026-11-16T21:00:00.000Z',
    ]) {
      assert(
        events.some((e) => e.medication_id === MED_DAILY && e.due_at === keptDueAt),
        `expected MED_DAILY event at ${keptDueAt} to exist after schedule edit`,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// Added in review (Claude, step 12). London in November is UTC+0, so the tests above
// cannot tell a handler that uses the circle's time zone from one that uses UTC.
// These use Europe/Paris (UTC+1 in November) and check exact due_at values.
// ---------------------------------------------------------------------------

const MED_PARIS = 'c1200001-0000-4000-8000-000000000004';
const MED_ENDS = 'c1200001-0000-4000-8000-000000000005';
const MED_STARTS = 'c1200001-0000-4000-8000-000000000006';
const MED_BAD_TZ = 'c1200001-0000-4000-8000-000000000007';
const NOW_REVIEW = new Date('2026-11-15T10:00:00.000Z');

function parisMed(
  id: string,
  times: string[],
  overrides: Partial<ActiveMedicationWithTimezoneRow> = {},
): ActiveMedicationWithTimezoneRow {
  return {
    id,
    circle_id: CIRCLE_A,
    schedule: { kind: 'daily', times },
    start_date: '2026-11-01',
    end_date: null,
    active: true,
    circle_timezone: 'Europe/Paris',
    ...overrides,
  };
}

function cronRequest(body?: unknown): Request {
  return new Request('http://localhost/functions/v1/materialize-doses', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${CRON_SECRET}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function dueAtsFor(events: DoseEventInsertRow[], medicationId: string): string[] {
  return events
    .filter((e) => e.medication_id === medicationId)
    .map((e) => e.due_at)
    .sort();
}

const sameList = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);

Deno.test(
  'materialize-doses uses the circle time zone, start_date, end_date and exactly [now, now + 48 h]',
  async () => {
    const { createMaterializeDosesHandler } = await loadHandlerModule();
    const meds = [
      // 11:00 and 11:30 Paris = 10:00Z and 10:30Z in November.
      // 10:00Z on the 15th is exactly now (included); 10:00Z on the 17th is exactly now + 48 h (included);
      // 10:30Z on the 17th is now + 48.5 h (excluded).
      parisMed(MED_PARIS, ['11:00', '11:30']),
      // 09:00 Paris = 08:00Z. Today's 08:00Z is already past. Ends on the 16th (Paris date).
      parisMed(MED_ENDS, ['09:00'], { end_date: '2026-11-16' }),
      // Starts on the 17th (Paris date).
      parisMed(MED_STARTS, ['09:00'], { start_date: '2026-11-17' }),
    ];
    const { store, events } = createInMemoryStore(meds);
    const handler = createMaterializeDosesHandler({
      cronSecret: CRON_SECRET,
      now: () => NOW_REVIEW,
      store,
    });

    const res = await handler(cronRequest());
    assert(res.status === 200, `expected 200, got ${res.status}`);

    const paris = dueAtsFor(events, MED_PARIS);
    assert(
      sameList(paris, [
        '2026-11-15T10:00:00.000Z',
        '2026-11-15T10:30:00.000Z',
        '2026-11-16T10:00:00.000Z',
        '2026-11-16T10:30:00.000Z',
        '2026-11-17T10:00:00.000Z',
      ]),
      `Paris daily 11:00/11:30 must be due at 10:00Z/10:30Z inside [now, now + 48 h], got ${JSON.stringify(paris)}`,
    );
    const ends = dueAtsFor(events, MED_ENDS);
    assert(
      sameList(ends, ['2026-11-16T08:00:00.000Z']),
      `a medicine ending on 2026-11-16 must get no dose on the 17th, got ${JSON.stringify(ends)}`,
    );
    const starts = dueAtsFor(events, MED_STARTS);
    assert(
      sameList(starts, ['2026-11-17T08:00:00.000Z']),
      `a medicine starting on 2026-11-17 must get no dose before it, got ${JSON.stringify(starts)}`,
    );
  },
);

Deno.test(
  'one broken medication does not stop the doses of every other family, and the run reports the failure',
  async () => {
    const { createMaterializeDosesHandler } = await loadHandlerModule();
    const meds = [
      parisMed(MED_BAD_TZ, ['08:00'], { circle_timezone: 'Mars/Olympus' }),
      parisMed(MED_PARIS, ['11:00']),
    ];
    const { store, events } = createInMemoryStore(meds);
    const handler = createMaterializeDosesHandler({
      cronSecret: CRON_SECRET,
      now: () => NOW_REVIEW,
      store,
    });

    const res = await handler(cronRequest());
    const body = (await res.json()) as { ok: boolean; inserted: number; failed: number };
    assert(
      dueAtsFor(events, MED_PARIS).length === 3,
      `the valid medicine must still get its 3 doses, got ${JSON.stringify(dueAtsFor(events, MED_PARIS))}`,
    );
    assert(dueAtsFor(events, MED_BAD_TZ).length === 0, 'the broken medicine gets no doses');
    // A partial failure must be visible in the pg_net response log, not reported as success.
    assert(res.status === 500, `a run with a failed medicine must answer 500, got ${res.status}`);
    assert(
      body.ok === false && body.failed === 1 && body.inserted === 3,
      `expected { ok: false, failed: 1, inserted: 3 }, got ${JSON.stringify(body)}`,
    );
  },
);

Deno.test('a failing database insert is reported as a failure, never as ok', async () => {
  const { createMaterializeDosesHandler } = await loadHandlerModule();
  const { store } = createInMemoryStore([parisMed(MED_PARIS, ['11:00'])]);
  const failingStore: Required<MaterializeDosesStore> = {
    ...store,
    insertPendingDoseEvents() {
      return Promise.reject(new Error('connection reset'));
    },
  };
  const handler = createMaterializeDosesHandler({
    cronSecret: CRON_SECRET,
    now: () => NOW_REVIEW,
    store: failingStore,
  });
  const res = await handler(cronRequest());
  const body = (await res.json()) as { ok: boolean };
  assert(res.status === 500 && body.ok === false, `expected 500 and ok: false, got ${res.status}`);
});

Deno.test(
  'a request naming one medication_id (sent by the database trigger after an edit) materializes only that medicine, right away',
  async () => {
    const { createMaterializeDosesHandler } = await loadHandlerModule();
    // The hourly run only looks 48 h ahead from "now". Without this call, a medicine added or edited at 10:05
    // with a dose at 10:30 would get no 10:30 event: the 11:00 run starts its window at 11:00.
    const meds = [parisMed(MED_PARIS, ['11:30']), parisMed(MED_OTHER, ['11:30'])];
    const { store, events } = createInMemoryStore(meds);
    const handler = createMaterializeDosesHandler({
      cronSecret: CRON_SECRET,
      now: () => NOW_REVIEW,
      store,
    });

    const res = await handler(cronRequest({ medication_id: MED_PARIS }));
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const paris = dueAtsFor(events, MED_PARIS);
    assert(
      sameList(paris, ['2026-11-15T10:30:00.000Z', '2026-11-16T10:30:00.000Z']),
      `the edited medicine gets today's 10:30Z dose and tomorrow's, got ${JSON.stringify(paris)}`,
    );
    assert(
      dueAtsFor(events, MED_OTHER).length === 0,
      'a request for one medicine must not materialize other medicines',
    );
  },
);

Deno.test(
  'schedule edit in a non-UTC circle, and pausing a medicine, re-materialize correctly',
  async () => {
    const { reconcileMedicationScheduleEdit } = await loadHandlerModule();
    const futurePending = (dueAt: string): DoseEventInsertRow => ({
      medication_id: MED_PARIS,
      circle_id: CIRCLE_A,
      due_at: dueAt,
      status: 'pending',
      acted_by: null,
      acted_at: null,
    });

    // Edit to 21:00 Paris = 20:00Z.
    const edited = parisMed(MED_PARIS, ['21:00']);
    const run1 = createInMemoryStore([edited], [futurePending('2026-11-15T19:00:00.000Z')]);
    const r1 = await reconcileMedicationScheduleEdit({
      medication: edited,
      now: NOW_REVIEW,
      store: run1.store,
    });
    const after1 = dueAtsFor(run1.events, MED_PARIS);
    assert(
      r1.deletedPending === 1 &&
        sameList(after1, ['2026-11-15T20:00:00.000Z', '2026-11-16T20:00:00.000Z']),
      `21:00 Paris must be 20:00Z, got ${JSON.stringify(after1)} (deleted ${r1.deletedPending})`,
    );

    // Pausing deletes the future pending doses and creates none.
    const paused = parisMed(MED_PARIS, ['21:00'], { active: false });
    const run2 = createInMemoryStore(
      [paused],
      [futurePending('2026-11-15T20:00:00.000Z'), futurePending('2026-11-16T20:00:00.000Z')],
    );
    const r2 = await reconcileMedicationScheduleEdit({
      medication: paused,
      now: NOW_REVIEW,
      store: run2.store,
    });
    assert(
      r2.deletedPending === 2 && r2.materialized === 0 && run2.events.length === 0,
      `a paused medicine keeps no future pending doses, got ${JSON.stringify(r2)}`,
    );

    // Switching to as_needed also leaves no future pending doses (spec rule 2).
    const asNeeded: ActiveMedicationWithTimezoneRow = {
      ...parisMed(MED_PARIS, []),
      schedule: { kind: 'as_needed' },
    };
    const run3 = createInMemoryStore([asNeeded], [futurePending('2026-11-15T20:00:00.000Z')]);
    const r3 = await reconcileMedicationScheduleEdit({
      medication: asNeeded,
      now: NOW_REVIEW,
      store: run3.store,
    });
    assert(
      r3.deletedPending === 1 && r3.materialized === 0 && run3.events.length === 0,
      `an as_needed medicine keeps no future pending doses, got ${JSON.stringify(r3)}`,
    );
  },
);
