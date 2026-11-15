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
