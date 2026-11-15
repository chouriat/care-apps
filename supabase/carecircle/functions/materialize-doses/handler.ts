import {
  materializeDoseTimes,
  validateMedicationSchedule,
  type DoseGeneratorMedication,
} from '../_shared/dose-logic.ts';

export const HORIZON_HOURS = 48;

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

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function toDoseGeneratorMedication(row: ActiveMedicationWithTimezoneRow): DoseGeneratorMedication {
  const schedule = validateMedicationSchedule(row.schedule);
  return {
    id: row.id,
    circleId: row.circle_id,
    schedule,
    startDate: row.start_date,
    endDate: row.end_date,
    active: row.active,
  };
}

export async function reconcileMedicationScheduleEdit(opts: {
  medication: ActiveMedicationWithTimezoneRow;
  now: Date;
  store: Required<MaterializeDosesStore>;
}): Promise<{ deletedPending: number; materialized: number }> {
  const { medication, now, store } = opts;
  const { deleted } = await store.deleteFuturePendingDoseEventsForMedication(
    medication.id,
    now.toISOString(),
  );

  const normalized = toDoseGeneratorMedication(medication);
  if (!normalized.active || normalized.schedule.kind === 'as_needed') {
    return { deletedPending: deleted, materialized: 0 };
  }

  const windowEnd = new Date(now.getTime() + HORIZON_HOURS * 3_600_000);
  const slots = materializeDoseTimes(normalized, medication.circle_timezone, now, windowEnd);
  if (slots.length === 0) {
    return { deletedPending: deleted, materialized: 0 };
  }

  const rows: DoseEventInsertRow[] = slots.map((slot) => ({
    medication_id: slot.medicationId,
    circle_id: slot.circleId,
    due_at: slot.dueAt,
    status: 'pending',
    acted_by: null,
    acted_at: null,
  }));

  const { inserted } = await store.insertPendingDoseEvents(rows);
  return { deletedPending: deleted, materialized: inserted };
}

export function createMaterializeDosesHandler(
  deps: MaterializeDosesHandlerDeps,
): (req: Request) => Promise<Response> {
  const nowFn = deps.now ?? (() => new Date());

  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') {
      return jsonResponse({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
    }

    const cronSecret = deps.cronSecret ?? '';
    if (!cronSecret) {
      return jsonResponse({ ok: false, error: 'CRON_SECRET_NOT_CONFIGURED' }, 500);
    }

    const authHeader = req.headers.get('authorization') ?? '';
    const hasBearerPrefix = authHeader.startsWith('Bearer ');
    const callerSecret = hasBearerPrefix ? authHeader.slice('Bearer '.length) : '';
    if (!hasBearerPrefix || !constantTimeEquals(callerSecret, cronSecret)) {
      return jsonResponse({ ok: false, error: 'UNAUTHORIZED' }, 401);
    }

    let filterMedicationId: string | null = null;
    try {
      const rawBody = await req.text();
      if (rawBody.trim().length > 0) {
        const parsed = JSON.parse(rawBody) as unknown;
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const candidate = (parsed as { medication_id?: unknown }).medication_id;
          if (typeof candidate === 'string' && candidate.trim().length > 0) {
            filterMedicationId = candidate.trim();
          }
        }
      }
    } catch {
      return jsonResponse({ ok: false, error: 'INVALID_JSON' }, 400);
    }

    let allMeds: ActiveMedicationWithTimezoneRow[];
    try {
      allMeds = await deps.store.listActiveMedications();
    } catch {
      console.info(
        JSON.stringify({
          event: 'materialize_doses_run',
          ok: false,
          processed: 0,
          inserted: 0,
          failed: 1,
          failedMedicationIds: [],
        }),
      );
      return jsonResponse({ ok: false, inserted: 0, failed: 1 }, 500);
    }

    const targetMeds =
      filterMedicationId !== null
        ? allMeds.filter((med) => med.id === filterMedicationId)
        : allMeds;

    const now = nowFn();
    const windowEnd = new Date(now.getTime() + HORIZON_HOURS * 3_600_000);

    let totalInserted = 0;
    let failed = 0;
    const failedMedicationIds: string[] = [];

    for (const med of targetMeds) {
      try {
        const normalized = toDoseGeneratorMedication(med);
        const slots = materializeDoseTimes(normalized, med.circle_timezone, now, windowEnd);
        if (slots.length === 0) {
          continue;
        }
        const rows: DoseEventInsertRow[] = slots.map((slot) => ({
          medication_id: slot.medicationId,
          circle_id: slot.circleId,
          due_at: slot.dueAt,
          status: 'pending',
          acted_by: null,
          acted_at: null,
        }));
        const { inserted } = await deps.store.insertPendingDoseEvents(rows);
        totalInserted += inserted;
      } catch {
        failed += 1;
        failedMedicationIds.push(med.id);
      }
    }

    // One log line per run: counts + failed medication IDs only (never names, strengths, or schedules).
    console.info(
      JSON.stringify({
        event: 'materialize_doses_run',
        ok: failed === 0,
        processed: targetMeds.length,
        inserted: totalInserted,
        failed,
        failedMedicationIds,
      }),
    );

    if (failed > 0) {
      return jsonResponse({ ok: false, inserted: totalInserted, failed }, 500);
    }
    return jsonResponse({ ok: true, inserted: totalInserted, failed: 0 }, 200);
  };
}
