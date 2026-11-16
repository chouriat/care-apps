import {
  circleRowSchema,
  doseEventRowSchema,
  medicationRowSchema,
  scheduleSchema,
  validateAnalyticsEvent,
  type Circle,
  type CircleRow,
  type DoseEvent,
  type DoseEventRow,
  type Medication,
  type MedicationRow,
  type MedicationSchedule,
  type MemberRole,
} from '@carecircle/core';
import { z } from 'zod';
import en from '../../../i18n/en.json';
import { getSupabaseClient } from '../auth/api';
import { fetchSignedInMemberRole } from '../circle/api';
import { loadCareCircleMocks } from '../mocks';
import { getAppObservability } from '../observability/api';
import {
  DEFAULT_MOCK_NOW_ISO,
  getOrInitMockTodaySnapshot,
  loadTodaySnapshot,
  type TodayDeps,
} from '../today/api';
import { requestTodayReload } from '../today/refresh';

const SEVEN_DAYS_MS = 7 * 86_400_000;
const ISO_DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export interface MedicationAdherence7d {
  givenCount: number;
  totalCount: number;
  percent: number | null;
  label: string;
}

export interface ActiveMedicationItem {
  medication: Medication;
  scheduleSummary: string;
  adherence7d: MedicationAdherence7d;
}

export const medicationWriteInputSchema = z
  .object({
    circleId: z.string().uuid(),
    name: z.string().trim().min(1),
    strength: z.string().trim().min(1).nullable().optional(),
    doseText: z.string().trim().min(1),
    schedule: scheduleSchema,
    instructions: z.string().trim().min(1).nullable().optional(),
    startDate: z.string().regex(ISO_DATE_PATTERN).nullable().optional(),
    endDate: z.string().regex(ISO_DATE_PATTERN).nullable().optional(),
  })
  .strict();

export type MedicationWriteInput = z.infer<typeof medicationWriteInputSchema>;

export type MedsErrorCode =
  | 'VALIDATION_ERROR'
  | 'FORBIDDEN_ROLE'
  | 'NETWORK_ERROR'
  | 'LOAD_MEDS_FAILED'
  | 'SAVE_MED_FAILED';

export interface MedsDeps extends TodayDeps {
  trackMedAdded?: () => void;
}

function capitalizeDay(day: string): string {
  return day.length > 0 ? day[0]!.toUpperCase() + day.slice(1) : day;
}

export function formatScheduleSummary(schedule: MedicationSchedule): string {
  switch (schedule.kind) {
    case 'daily':
      return `${en.meds.scheduleKindDaily} · ${schedule.times.join(', ')}`;
    case 'weekly':
      return `${en.meds.scheduleKindWeekly} (${schedule.days.map(capitalizeDay).join(', ')}) · ${schedule.times.join(', ')}`;
    case 'every_n_days':
      return `${en.meds.scheduleEveryNDaysSummary.replace('{n}', String(schedule.n))} · ${schedule.times.join(', ')}`;
    case 'as_needed':
      return en.meds.scheduleKindAsNeeded;
  }
}

export function computeMedicationAdherence7d(
  medication: Medication,
  doseEvents: ReadonlyArray<DoseEvent>,
  now: Date = new Date(),
): MedicationAdherence7d {
  if (medication.schedule.kind === 'as_needed') {
    return {
      givenCount: 0,
      totalCount: 0,
      percent: null,
      label: en.meds.adherenceAsNeeded,
    };
  }

  const nowMs = now.getTime();
  const windowStartMs = nowMs - SEVEN_DAYS_MS;

  const relevantDoses = doseEvents.filter((dose) => {
    if (dose.medicationId !== medication.id) return false;
    const dueMs = new Date(dose.dueAt).getTime();
    return Number.isFinite(dueMs) && dueMs >= windowStartMs && dueMs <= nowMs;
  });

  const totalCount = relevantDoses.length;
  if (totalCount === 0) {
    return {
      givenCount: 0,
      totalCount: 0,
      percent: null,
      label: en.meds.adherenceNoDoses,
    };
  }

  const givenCount = relevantDoses.filter((dose) => dose.status === 'given').length;
  const percent = Math.round((givenCount / totalCount) * 100);

  return {
    givenCount,
    totalCount,
    percent,
    label: en.meds.adherenceSummary
      .replace('{given}', String(givenCount))
      .replace('{total}', String(totalCount))
      .replace('{percent}', String(percent)),
  };
}

function normalizeIsoTimestamp(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function circleFromRow(row: CircleRow): Circle {
  return {
    id: row.id,
    name: row.name,
    careRecipientName: row.care_recipient_name,
    careRecipientDob: row.care_recipient_dob,
    timezone: row.timezone,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function medicationFromRow(row: MedicationRow): Medication {
  return {
    id: row.id,
    circleId: row.circle_id,
    name: row.name,
    strength: row.strength,
    doseText: row.dose_text,
    schedule: row.schedule,
    instructions: row.instructions,
    startDate: row.start_date,
    endDate: row.end_date,
    active: row.active,
    source: row.source,
  };
}

function doseEventFromRow(row: DoseEventRow): DoseEvent {
  return {
    id: row.id,
    medicationId: row.medication_id,
    circleId: row.circle_id,
    dueAt: row.due_at,
    status: row.status,
    actedBy: row.acted_by,
    actedAt: row.acted_at,
  };
}

function isNetworkFailureMessage(message: string, code?: string): boolean {
  if (code === 'NETWORK_ERROR') return true;
  return /network|fetch failed|failed to fetch|offline|load failed/i.test(message);
}

async function resolveUserId(deps: MedsDeps): Promise<string | null> {
  try {
    if (deps.getUserId) return await deps.getUserId();
    const { data } = await getSupabaseClient().auth.getSession();
    return data.session?.user.id ?? null;
  } catch {
    return null;
  }
}

// The server has already saved the change when this runs. Refreshing Today's offline copy and
// telling the Today screen to reload must never turn that success into "Not saved": the person
// would tap Save again and the medicine would be added twice.
async function refreshTodayAfterSave(deps: MedsDeps): Promise<void> {
  try {
    await loadTodaySnapshot(deps);
  } catch {
    // Today reloads by itself on its next open, foreground or retry.
  }
  requestTodayReload();
}

function defaultTrackMedAdded(): void {
  const payload = validateAnalyticsEvent('cc_med_added', { source: 'manual' });
  void getAppObservability()
    .analytics.track('cc_med_added', payload as { source: 'manual' })
    .catch(() => undefined);
}

export type LoadMedicationsResult =
  | {
      ok: true;
      circle: Circle;
      memberRole: MemberRole;
      items: ActiveMedicationItem[];
      isOffline: boolean;
    }
  | {
      ok: false;
      errorCode: 'NETWORK_ERROR' | 'LOAD_MEDS_FAILED';
      isOffline: boolean;
    };

export async function loadMedicationsScreen(deps: MedsDeps = {}): Promise<LoadMedicationsResult> {
  const mocks = loadCareCircleMocks(deps.env);
  const nowFn = deps.now ?? (() => (mocks ? new Date(DEFAULT_MOCK_NOW_ISO) : new Date()));
  const now = nowFn();

  if (mocks) {
    const snapshot = getOrInitMockTodaySnapshot(mocks);
    const activeMeds = snapshot.medications.filter((m) => m.active);
    const items: ActiveMedicationItem[] = activeMeds.map((med) => ({
      medication: med,
      scheduleSummary: formatScheduleSummary(med.schedule),
      adherence7d: computeMedicationAdherence7d(med, snapshot.doseEvents, now),
    }));
    return {
      ok: true,
      circle: snapshot.circle,
      memberRole: snapshot.memberRole,
      items,
      isOffline: Boolean(deps.isOffline),
    };
  }

  if (deps.isOffline) {
    return {
      ok: false,
      errorCode: 'NETWORK_ERROR',
      isOffline: true,
    };
  }

  const getClient = deps.getClient ?? getSupabaseClient;
  const userId = await resolveUserId(deps);

  try {
    const client = getClient();
    const circlesRes = await client
      .from('circles')
      .select('*')
      .order('created_at', { ascending: true })
      .limit(1);

    if (circlesRes.error) {
      throw new Error(circlesRes.error.message);
    }

    const circleRows = Array.isArray(circlesRes.data) ? circlesRes.data : [];
    if (circleRows.length === 0) {
      return {
        ok: true,
        circle: {
          id: '00000000-0000-4000-8000-000000000000',
          name: 'CareCircle',
          careRecipientName: '',
          careRecipientDob: null,
          timezone: 'UTC',
          createdBy: null,
          createdAt: now.toISOString(),
        },
        memberRole: 'viewer',
        items: [],
        isOffline: false,
      };
    }

    const rawCircle = { ...(circleRows[0] as Record<string, unknown>) };
    rawCircle.created_at = normalizeIsoTimestamp(rawCircle.created_at);
    const circle = circleFromRow(circleRowSchema.parse(rawCircle));

    const nowMs = now.getTime();
    const windowStartIso = new Date(nowMs - SEVEN_DAYS_MS).toISOString();
    const windowEndIso = new Date(nowMs).toISOString();

    const [roleRes, medsRes, dosesRes] = await Promise.all([
      fetchSignedInMemberRole(client, circle.id, userId),
      client.from('medications').select('*').eq('circle_id', circle.id),
      client
        .from('dose_events')
        .select('*')
        .eq('circle_id', circle.id)
        .gte('due_at', windowStartIso)
        .lte('due_at', windowEndIso),
    ]);

    if (roleRes.error) throw new Error(roleRes.error.message);
    if (medsRes.error) throw new Error(medsRes.error.message);
    if (dosesRes.error) throw new Error(dosesRes.error.message);

    const medications = (Array.isArray(medsRes.data) ? medsRes.data : []).map((row) =>
      medicationFromRow(medicationRowSchema.parse(row)),
    );

    const doseEvents = (Array.isArray(dosesRes.data) ? dosesRes.data : []).map((row) => {
      const normalized = { ...(row as Record<string, unknown>) };
      normalized.due_at = normalizeIsoTimestamp(normalized.due_at);
      normalized.acted_at = normalizeIsoTimestamp(normalized.acted_at);
      return doseEventFromRow(doseEventRowSchema.parse(normalized));
    });

    const activeMeds = medications.filter((m) => m.active);
    const items: ActiveMedicationItem[] = activeMeds.map((med) => ({
      medication: med,
      scheduleSummary: formatScheduleSummary(med.schedule),
      adherence7d: computeMedicationAdherence7d(med, doseEvents, now),
    }));

    return {
      ok: true,
      circle,
      memberRole: roleRes.role,
      items,
      isOffline: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const offline = isNetworkFailureMessage(message);
    return {
      ok: false,
      errorCode: offline ? 'NETWORK_ERROR' : 'LOAD_MEDS_FAILED',
      isOffline: offline,
    };
  }
}

export async function addMedication(
  input: {
    circleId: string;
    name: string;
    strength?: string | null;
    doseText: string;
    schedule: MedicationSchedule;
    instructions?: string | null;
    startDate?: string | null;
    endDate?: string | null;
    memberRole?: MemberRole;
  },
  deps: MedsDeps = {},
): Promise<
  { ok: true; medication: Medication } | { ok: false; errorCode: MedsErrorCode; isOffline: boolean }
> {
  if (input.memberRole === 'viewer') {
    return { ok: false, errorCode: 'FORBIDDEN_ROLE', isOffline: false };
  }

  const parsed = medicationWriteInputSchema.safeParse({
    circleId: input.circleId,
    name: input.name,
    strength: input.strength?.trim() ? input.strength.trim() : null,
    doseText: input.doseText,
    schedule: input.schedule,
    instructions: input.instructions?.trim() ? input.instructions.trim() : null,
    startDate: input.startDate?.trim() ? input.startDate.trim() : null,
    endDate: input.endDate?.trim() ? input.endDate.trim() : null,
  });

  if (!parsed.success) {
    return { ok: false, errorCode: 'VALIDATION_ERROR', isOffline: false };
  }

  if (deps.isOffline) {
    return { ok: false, errorCode: 'NETWORK_ERROR', isOffline: true };
  }

  const trackMedAdded = deps.trackMedAdded ?? defaultTrackMedAdded;
  const mocks = loadCareCircleMocks(deps.env);

  if (mocks) {
    const snapshot = getOrInitMockTodaySnapshot(mocks);
    const created: Medication = {
      id: `c1200099-0000-4000-8000-${String(snapshot.medications.length + 1).padStart(12, '0')}`,
      circleId: parsed.data.circleId,
      name: parsed.data.name,
      strength: parsed.data.strength ?? null,
      doseText: parsed.data.doseText,
      schedule: parsed.data.schedule,
      instructions: parsed.data.instructions ?? null,
      startDate: parsed.data.startDate ?? '2026-11-15',
      endDate: parsed.data.endDate ?? null,
      active: true,
      source: 'manual',
    };
    snapshot.medications.push(created);
    trackMedAdded();
    await refreshTodayAfterSave(deps);
    return { ok: true, medication: created };
  }

  const getClient = deps.getClient ?? getSupabaseClient;

  try {
    const client = getClient();
    const res = await client
      .from('medications')
      .insert({
        circle_id: parsed.data.circleId,
        name: parsed.data.name,
        strength: parsed.data.strength ?? null,
        dose_text: parsed.data.doseText,
        schedule: parsed.data.schedule,
        instructions: parsed.data.instructions ?? null,
        // No start date typed: leave it out so the database default (today) applies. Sending
        // null would store a medicine with no start date.
        ...(parsed.data.startDate ? { start_date: parsed.data.startDate } : {}),
        end_date: parsed.data.endDate ?? null,
        active: true,
        source: 'manual',
      })
      .select('*');

    if (res.error) {
      const offline = isNetworkFailureMessage(res.error.message, res.error.code);
      return {
        ok: false,
        errorCode: offline ? 'NETWORK_ERROR' : 'SAVE_MED_FAILED',
        isOffline: offline,
      };
    }

    const rows = Array.isArray(res.data) ? res.data : [];
    if (rows.length === 0) {
      return { ok: false, errorCode: 'SAVE_MED_FAILED', isOffline: false };
    }

    const medication = medicationFromRow(medicationRowSchema.parse(rows[0]));
    trackMedAdded();
    await refreshTodayAfterSave(deps);
    return { ok: true, medication };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const offline = isNetworkFailureMessage(message);
    return {
      ok: false,
      errorCode: offline ? 'NETWORK_ERROR' : 'SAVE_MED_FAILED',
      isOffline: offline,
    };
  }
}

export async function updateMedication(
  input: {
    circleId: string;
    medicationId: string;
    name: string;
    strength?: string | null;
    doseText: string;
    schedule: MedicationSchedule;
    instructions?: string | null;
    startDate?: string | null;
    endDate?: string | null;
    memberRole?: MemberRole;
  },
  deps: MedsDeps = {},
): Promise<
  { ok: true; medication: Medication } | { ok: false; errorCode: MedsErrorCode; isOffline: boolean }
> {
  if (input.memberRole === 'viewer') {
    return { ok: false, errorCode: 'FORBIDDEN_ROLE', isOffline: false };
  }

  const parsed = medicationWriteInputSchema.safeParse({
    circleId: input.circleId,
    name: input.name,
    strength: input.strength?.trim() ? input.strength.trim() : null,
    doseText: input.doseText,
    schedule: input.schedule,
    instructions: input.instructions?.trim() ? input.instructions.trim() : null,
    startDate: input.startDate?.trim() ? input.startDate.trim() : null,
    endDate: input.endDate?.trim() ? input.endDate.trim() : null,
  });

  if (!parsed.success || !input.medicationId.trim()) {
    return { ok: false, errorCode: 'VALIDATION_ERROR', isOffline: false };
  }

  if (deps.isOffline) {
    return { ok: false, errorCode: 'NETWORK_ERROR', isOffline: true };
  }

  const mocks = loadCareCircleMocks(deps.env);
  if (mocks) {
    const snapshot = getOrInitMockTodaySnapshot(mocks);
    const idx = snapshot.medications.findIndex((m) => m.id === input.medicationId);
    if (idx < 0) {
      return { ok: false, errorCode: 'SAVE_MED_FAILED', isOffline: false };
    }
    const existing = snapshot.medications[idx]!;
    const updated: Medication = {
      ...existing,
      name: parsed.data.name,
      strength: parsed.data.strength ?? null,
      doseText: parsed.data.doseText,
      schedule: parsed.data.schedule,
      instructions: parsed.data.instructions ?? null,
      startDate: parsed.data.startDate ?? existing.startDate,
      endDate: parsed.data.endDate ?? null,
    };
    snapshot.medications[idx] = updated;
    await refreshTodayAfterSave(deps);
    return { ok: true, medication: updated };
  }

  const getClient = deps.getClient ?? getSupabaseClient;

  try {
    const client = getClient();
    const res = await client
      .from('medications')
      .update({
        name: parsed.data.name,
        strength: parsed.data.strength ?? null,
        dose_text: parsed.data.doseText,
        schedule: parsed.data.schedule,
        instructions: parsed.data.instructions ?? null,
        ...(parsed.data.startDate ? { start_date: parsed.data.startDate } : {}),
        end_date: parsed.data.endDate ?? null,
      })
      .eq('circle_id', parsed.data.circleId)
      .eq('id', input.medicationId.trim())
      .select('*');

    if (res.error) {
      const offline = isNetworkFailureMessage(res.error.message, res.error.code);
      return {
        ok: false,
        errorCode: offline ? 'NETWORK_ERROR' : 'SAVE_MED_FAILED',
        isOffline: offline,
      };
    }

    const rows = Array.isArray(res.data) ? res.data : [];
    if (rows.length === 0) {
      return { ok: false, errorCode: 'SAVE_MED_FAILED', isOffline: false };
    }

    const medication = medicationFromRow(medicationRowSchema.parse(rows[0]));
    await refreshTodayAfterSave(deps);
    return { ok: true, medication };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const offline = isNetworkFailureMessage(message);
    return {
      ok: false,
      errorCode: offline ? 'NETWORK_ERROR' : 'SAVE_MED_FAILED',
      isOffline: offline,
    };
  }
}

export async function pauseMedication(
  input: {
    circleId: string;
    medicationId: string;
    memberRole?: MemberRole;
  },
  deps: MedsDeps = {},
): Promise<{ ok: true } | { ok: false; errorCode: MedsErrorCode; isOffline: boolean }> {
  if (input.memberRole === 'viewer') {
    return { ok: false, errorCode: 'FORBIDDEN_ROLE', isOffline: false };
  }

  if (!input.circleId.trim() || !input.medicationId.trim()) {
    return { ok: false, errorCode: 'VALIDATION_ERROR', isOffline: false };
  }

  if (deps.isOffline) {
    return { ok: false, errorCode: 'NETWORK_ERROR', isOffline: true };
  }

  const mocks = loadCareCircleMocks(deps.env);
  if (mocks) {
    const snapshot = getOrInitMockTodaySnapshot(mocks);
    const target = snapshot.medications.find((m) => m.id === input.medicationId);
    if (!target) {
      return { ok: false, errorCode: 'SAVE_MED_FAILED', isOffline: false };
    }
    target.active = false;
    await refreshTodayAfterSave(deps);
    return { ok: true };
  }

  const getClient = deps.getClient ?? getSupabaseClient;

  try {
    const client = getClient();
    const res = await client
      .from('medications')
      .update({ active: false })
      .eq('circle_id', input.circleId.trim())
      .eq('id', input.medicationId.trim())
      .select('*');

    if (res.error) {
      const offline = isNetworkFailureMessage(res.error.message, res.error.code);
      return {
        ok: false,
        errorCode: offline ? 'NETWORK_ERROR' : 'SAVE_MED_FAILED',
        isOffline: offline,
      };
    }

    const rows = Array.isArray(res.data) ? res.data : [];
    if (rows.length === 0) {
      return { ok: false, errorCode: 'SAVE_MED_FAILED', isOffline: false };
    }

    await refreshTodayAfterSave(deps);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const offline = isNetworkFailureMessage(message);
    return {
      ok: false,
      errorCode: offline ? 'NETWORK_ERROR' : 'SAVE_MED_FAILED',
      isOffline: offline,
    };
  }
}
