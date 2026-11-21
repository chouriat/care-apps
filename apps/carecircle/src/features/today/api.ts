import {
  appointmentRowSchema,
  appointmentSchema,
  circleRowSchema,
  circleSchema,
  doseEventRowSchema,
  doseEventSchema,
  isNetworkFailureMessage,
  medicationRowSchema,
  medicationSchema,
  memberRoleSchema,
  taskRowSchema,
  taskSchema,
  type Appointment,
  type AppointmentRow,
  type Circle,
  type CircleRow,
  type DoseEvent,
  type DoseEventRow,
  type DoseStatus,
  type Medication,
  type MedicationRow,
  type MemberRole,
  type Task,
  type TaskRow,
} from '@carecircle/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { File, Paths } from 'expo-file-system';
import { z } from 'zod';
import { getSupabaseClient } from '../auth/api';
import { fetchSignedInMemberRole } from '../circle/api';
import { loadCareCircleMocks, type CareCircleMocks } from '../mocks';
import { getAppObservability } from '../observability/api';

export const TODAY_SNAPSHOT_CACHE_KEY = 'carecircle.today.snapshot.v1';
export const TODAY_CHECKOFF_QUEUE_KEY = 'carecircle.today.checkoff_queue.v1';
export const DEFAULT_MOCK_NOW_ISO = '2026-11-15T12:00:00.000Z';

export const todayDoseStatusActionSchema = z.enum(['given', 'skipped']);
export type TodayDoseStatusAction = z.infer<typeof todayDoseStatusActionSchema>;

export interface TodayDoseItem {
  id: string;
  medicationId: string;
  medicationName: string;
  strength: string | null;
  doseText: string;
  instructions: string | null;
  dueAt: string;
  localTime: string;
  status: DoseStatus;
  actedBy: string | null;
  actedAt: string | null;
}

export interface TodayDoseGroup {
  time: string;
  doses: TodayDoseItem[];
}

export interface TodayPrnGivenDose {
  id: string;
  dueAt: string;
  localTime: string;
  actedBy: string | null;
  actedAt: string | null;
}

export interface TodayPrnMedicationItem {
  id: string;
  name: string;
  strength: string | null;
  doseText: string;
  instructions: string | null;
  givenToday: TodayPrnGivenDose[];
}

export const todaySnapshotSchema = z
  .object({
    circle: circleSchema,
    memberRole: memberRoleSchema,
    medications: z.array(medicationSchema),
    doseEvents: z.array(doseEventSchema),
    appointments: z.array(appointmentSchema),
    tasks: z.array(taskSchema),
    fetchedAt: z.string().datetime({ offset: true }),
    // The signed-in user the snapshot was loaded for. A cached snapshot or queued check-off is
    // only used for that same user, so a second account on the same phone never sees or sends
    // the first account's family data.
    userId: z.string().uuid().nullable().optional(),
  })
  .strict();

export type TodaySnapshot = z.infer<typeof todaySnapshotSchema>;

export const queuedDoseCheckOffSchema = z
  .object({
    doseEventId: z.string().uuid(),
    status: todayDoseStatusActionSchema,
    actedAt: z.string().datetime({ offset: true }),
    userId: z.string().uuid().nullable().optional(),
  })
  .strict();

export type QueuedDoseCheckOff = z.infer<typeof queuedDoseCheckOffSchema>;

export interface TodayAgenda {
  localDate: string;
  timezone: string;
  memberRole: MemberRole;
  doseGroups: TodayDoseGroup[];
  prnMedications?: TodayPrnMedicationItem[];
  nextAppointment: Appointment | null;
  tasksDueToday: Task[];
  isEmpty: boolean;
}

export interface TodayStorageAdapter {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem?(key: string): Promise<void> | void;
}

const memoryStore = new Map<string, string>();

export const memoryTodayStorage: TodayStorageAdapter = {
  getItem(key: string): string | null {
    return memoryStore.get(key) ?? null;
  },
  setItem(key: string, value: string): void {
    memoryStore.set(key, value);
  },
  removeItem(key: string): void {
    memoryStore.delete(key);
  },
};

// The offline cache and the check-off queue must survive the app being closed: a carer who taps
// Given on a plane and then swipes the app away must not lose the check-off, or another carer
// could see the dose as still due. Memory alone loses both. expo-file-system is already a
// dependency. The queue (dose ids and statuses only) goes in the document folder, which the OS
// keeps; the snapshot (medicine names) goes in the cache folder, which is not backed up and
// which the OS may clear when space is low, which only costs a reload.
// https://docs.expo.dev/versions/latest/sdk/filesystem/ (checked 2026-11-16)
function fileForKey(key: string): File {
  const dir = key === TODAY_CHECKOFF_QUEUE_KEY ? Paths.document : Paths.cache;
  return new File(dir, `${key}.json`);
}

export const fileTodayStorage: TodayStorageAdapter = {
  async getItem(key: string): Promise<string | null> {
    const file = fileForKey(key);
    return file.exists ? await file.text() : null;
  },
  async setItem(key: string, value: string): Promise<void> {
    const file = fileForKey(key);
    if (!file.exists) file.create();
    await file.write(value);
  },
  removeItem(key: string): void {
    const file = fileForKey(key);
    if (file.exists) file.delete();
  },
};

function canUseFileStorage(): boolean {
  try {
    return Boolean(Paths.document?.uri);
  } catch {
    return false;
  }
}

// Files on the phone; memory only where the native module is missing (Jest, web export).
export const defaultTodayStorage: TodayStorageAdapter = {
  async getItem(key) {
    return canUseFileStorage() ? fileTodayStorage.getItem(key) : memoryTodayStorage.getItem(key);
  },
  async setItem(key, value) {
    return canUseFileStorage()
      ? fileTodayStorage.setItem(key, value)
      : memoryTodayStorage.setItem(key, value);
  },
  async removeItem(key) {
    return canUseFileStorage()
      ? fileTodayStorage.removeItem?.(key)
      : memoryTodayStorage.removeItem?.(key);
  },
};

let mockSnapshotState: TodaySnapshot | null = null;

export function resetTodayState(): void {
  memoryStore.clear();
  mockSnapshotState = null;
}

export function formatLocalDateInZone(input: string | Date, timeZone: string): string {
  const date = typeof input === 'string' ? new Date(input) : input;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

export function formatLocalTimeInZone(input: string | Date, timeZone: string): string {
  const date = typeof input === 'string' ? new Date(input) : input;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const hourRaw = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const hour = hourRaw === '24' ? '00' : hourRaw.padStart(2, '0');
  return `${hour}:${minute.padStart(2, '0')}`;
}

/**
 * Computes the number of milliseconds from `now` until the next local midnight (`00:00:00`)
 * in the circle's IANA `timeZone`, so Today reloads as soon as the date in the circle's time zone rolls over.
 */
export function msUntilNextMidnightInZone(now: Date, timeZone: string): number {
  const localDate = formatLocalDateInZone(now, timeZone);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) {
    return 60_000;
  }
  const year = Number.parseInt(match[1] ?? '1970', 10);
  const month = Number.parseInt(match[2] ?? '1', 10);
  const day = Number.parseInt(match[3] ?? '1', 10);
  const targetNextMidnightWallMs = Date.UTC(year, month - 1, day + 1, 0, 0, 0, 0);

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    return Math.max(1_000, targetNextMidnightWallMs - now.getTime());
  }

  const getLocalWallMs = (utcMs: number): number => {
    const parts = formatter.formatToParts(new Date(utcMs));
    const y = Number.parseInt(parts.find((p) => p.type === 'year')?.value ?? '1970', 10);
    const m = Number.parseInt(parts.find((p) => p.type === 'month')?.value ?? '1', 10);
    const d = Number.parseInt(parts.find((p) => p.type === 'day')?.value ?? '1', 10);
    const hRaw = Number.parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
    const min = Number.parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
    const sec = Number.parseInt(parts.find((p) => p.type === 'second')?.value ?? '0', 10);
    const h = hRaw === 24 ? 0 : hRaw;
    return Date.UTC(y, m - 1, d, h, min, sec, 0);
  };

  let guess = targetNextMidnightWallMs;
  for (let i = 0; i < 3; i += 1) {
    const diff = getLocalWallMs(guess) - targetNextMidnightWallMs;
    if (diff === 0) break;
    guess -= diff;
  }

  return Math.max(1_000, guess - now.getTime());
}

export function selectTodayAgenda(snapshot: TodaySnapshot, now: Date = new Date()): TodayAgenda {
  const timezone = snapshot.circle.timezone;
  const localDate = formatLocalDateInZone(now, timezone);
  const medById = new Map<string, Medication>(
    snapshot.medications.map((med) => [med.id, med] as const),
  );

  const todayDoseItems: TodayDoseItem[] = [];
  const prnGivenByMedId = new Map<string, TodayPrnGivenDose[]>();
  for (const dose of snapshot.doseEvents) {
    if (formatLocalDateInZone(dose.dueAt, timezone) !== localDate) {
      continue;
    }
    const med = medById.get(dose.medicationId);
    if (med && !med.active) {
      continue;
    }
    if (med?.schedule.kind === 'as_needed') {
      if (dose.status === 'given') {
        const entry: TodayPrnGivenDose = {
          id: dose.id,
          dueAt: dose.dueAt,
          localTime: formatLocalTimeInZone(dose.dueAt, timezone),
          actedBy: dose.actedBy,
          actedAt: dose.actedAt,
        };
        const existing = prnGivenByMedId.get(med.id);
        if (existing) {
          existing.push(entry);
        } else {
          prnGivenByMedId.set(med.id, [entry]);
        }
      }
      continue;
    }
    todayDoseItems.push({
      id: dose.id,
      medicationId: dose.medicationId,
      medicationName: med?.name ?? 'Medication',
      strength: med?.strength ?? null,
      doseText: med?.doseText ?? '',
      instructions: med?.instructions ?? null,
      dueAt: dose.dueAt,
      localTime: formatLocalTimeInZone(dose.dueAt, timezone),
      status: dose.status,
      actedBy: dose.actedBy,
      actedAt: dose.actedAt,
    });
  }

  const prnMedications: TodayPrnMedicationItem[] = snapshot.medications
    .filter((med) => med.active && med.schedule.kind === 'as_needed')
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((med) => {
      const givenToday = [...(prnGivenByMedId.get(med.id) ?? [])].sort(
        (a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime(),
      );
      return {
        id: med.id,
        name: med.name,
        strength: med.strength,
        doseText: med.doseText,
        instructions: med.instructions,
        givenToday,
      };
    });

  todayDoseItems.sort((a, b) => {
    const timeCmp = a.localTime.localeCompare(b.localTime);
    if (timeCmp !== 0) return timeCmp;
    const dueCmp = new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
    if (dueCmp !== 0) return dueCmp;
    return a.medicationName.localeCompare(b.medicationName);
  });

  const groupsByTime = new Map<string, TodayDoseItem[]>();
  for (const item of todayDoseItems) {
    const bucket = groupsByTime.get(item.localTime);
    if (bucket) {
      bucket.push(item);
    } else {
      groupsByTime.set(item.localTime, [item]);
    }
  }

  const doseGroups: TodayDoseGroup[] = Array.from(groupsByTime.entries())
    .sort(([timeA], [timeB]) => timeA.localeCompare(timeB))
    .map(([time, doses]) => ({ time, doses }));

  const nowMs = now.getTime();
  const upcomingAppointments = snapshot.appointments
    .filter((appt) => new Date(appt.startsAt).getTime() >= nowMs)
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  const nextAppointment = upcomingAppointments[0] ?? null;

  const tasksDueToday = snapshot.tasks
    .filter(
      (task) =>
        task.doneAt === null &&
        task.dueAt !== null &&
        formatLocalDateInZone(task.dueAt, timezone) === localDate,
    )
    .sort((a, b) => new Date(a.dueAt!).getTime() - new Date(b.dueAt!).getTime());

  const isEmpty =
    doseGroups.length === 0 &&
    prnMedications.length === 0 &&
    nextAppointment === null &&
    tasksDueToday.length === 0;

  return {
    localDate,
    timezone,
    memberRole: snapshot.memberRole,
    doseGroups,
    prnMedications,
    nextAppointment,
    tasksDueToday,
    isEmpty,
  };
}

export function buildSnapshotFromMocks(
  mocks: CareCircleMocks,
  role: MemberRole = 'owner',
): TodaySnapshot {
  return {
    circle: { ...mocks.circle },
    memberRole: role,
    medications: mocks.medications.map((m) => ({ ...m })),
    doseEvents: mocks.doseEvents.map((d) => ({ ...d })),
    appointments: mocks.appointments.map((a) => ({ ...a })),
    tasks: mocks.tasks.map((t) => ({ ...t })),
    fetchedAt: DEFAULT_MOCK_NOW_ISO,
  };
}

export function getOrInitMockTodaySnapshot(
  mocks: CareCircleMocks,
  role: MemberRole = 'owner',
): TodaySnapshot {
  if (!mockSnapshotState) {
    mockSnapshotState = buildSnapshotFromMocks(mocks, role);
  }
  return mockSnapshotState;
}

export function applyQueuedCheckOffsToSnapshot(
  snapshot: TodaySnapshot,
  queue: ReadonlyArray<QueuedDoseCheckOff>,
): TodaySnapshot {
  if (queue.length === 0) {
    return snapshot;
  }
  const byDoseId = new Map<string, QueuedDoseCheckOff>();
  for (const item of queue) {
    byDoseId.set(item.doseEventId, item);
  }
  return {
    ...snapshot,
    doseEvents: snapshot.doseEvents.map((dose) => {
      const queued = byDoseId.get(dose.id);
      if (!queued) return dose;
      return {
        ...dose,
        status: queued.status,
        actedAt: queued.actedAt,
      };
    }),
  };
}

export async function loadQueuedDoseCheckOffs(
  storage: TodayStorageAdapter = defaultTodayStorage,
  userId?: string | null,
): Promise<QueuedDoseCheckOff[]> {
  try {
    const raw = await storage.getItem(TODAY_CHECKOFF_QUEUE_KEY);
    if (!raw) return [];
    const parsed = z.array(queuedDoseCheckOffSchema).safeParse(JSON.parse(raw));
    if (!parsed.success) return [];
    // With a user id, only that user's check-offs count (another account on this phone must
    // never send them under its own name).
    return userId === undefined
      ? parsed.data
      : parsed.data.filter((item) => (item.userId ?? null) === userId);
  } catch {
    return [];
  }
}

export async function saveQueuedDoseCheckOffs(
  queue: ReadonlyArray<QueuedDoseCheckOff>,
  storage: TodayStorageAdapter = defaultTodayStorage,
): Promise<void> {
  await storage.setItem(TODAY_CHECKOFF_QUEUE_KEY, JSON.stringify(queue));
}

export async function saveCachedTodaySnapshot(
  snapshot: TodaySnapshot,
  storage: TodayStorageAdapter = defaultTodayStorage,
): Promise<void> {
  await storage.setItem(TODAY_SNAPSHOT_CACHE_KEY, JSON.stringify(snapshot));
}

export async function loadCachedTodaySnapshot(
  storage: TodayStorageAdapter = defaultTodayStorage,
  userId?: string | null,
): Promise<TodaySnapshot | null> {
  try {
    const raw = await storage.getItem(TODAY_SNAPSHOT_CACHE_KEY);
    if (!raw) return null;
    const parsed = todaySnapshotSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    if (userId !== undefined && (parsed.data.userId ?? null) !== userId) return null;
    const queue = await loadQueuedDoseCheckOffs(storage, userId);
    return applyQueuedCheckOffsToSnapshot(parsed.data, queue);
  } catch {
    return null;
  }
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

function appointmentFromRow(row: AppointmentRow): Appointment {
  return {
    id: row.id,
    circleId: row.circle_id,
    title: row.title,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    location: row.location,
    driverUserId: row.driver_user_id,
    notes: row.notes,
  };
}

function taskFromRow(row: TaskRow): Task {
  return {
    id: row.id,
    circleId: row.circle_id,
    title: row.title,
    dueAt: row.due_at,
    assignee: row.assignee,
    doneAt: row.done_at,
    doneBy: row.done_by,
    source: row.source,
  };
}

export type TodayLoadErrorCode = 'NETWORK_ERROR' | 'LOAD_TODAY_FAILED';

export type LoadTodaySnapshotResult =
  | {
      ok: true;
      snapshot: TodaySnapshot;
      fromCache: boolean;
      isOffline: boolean;
      queuedCount: number;
    }
  | {
      ok: false;
      errorCode: TodayLoadErrorCode;
      isOffline: boolean;
    };

export interface TodayDeps {
  getClient?: () => Pick<SupabaseClient, 'from' | 'rpc'>;
  /** The signed-in user's id. The default reads the stored session, which works offline. */
  getUserId?: () => Promise<string | null>;
  storage?: TodayStorageAdapter;
  env?: Record<string, string | undefined>;
  isOffline?: boolean;
  now?: () => Date;
  trackDoseAction?: (status: TodayDoseStatusAction) => void;
}

async function resolveUserId(deps: TodayDeps): Promise<string | null> {
  try {
    if (deps.getUserId) return await deps.getUserId();
    const { data } = await getSupabaseClient().auth.getSession();
    return data.session?.user.id ?? null;
  } catch {
    return null;
  }
}

// Doses older than this are history (care log), not Today. Loading every dose the circle ever
// had would grow without limit; this window covers "today" in any time zone.
const DOSE_WINDOW_HOURS = 36;

function defaultTrackDoseAction(status: TodayDoseStatusAction): void {
  void getAppObservability()
    .analytics.track('cc_dose_given', { status })
    .catch(() => undefined);
}

export async function loadTodaySnapshot(deps: TodayDeps = {}): Promise<LoadTodaySnapshotResult> {
  const storage = deps.storage ?? defaultTodayStorage;
  const nowFn = deps.now ?? (() => new Date());
  const mocks = loadCareCircleMocks(deps.env);

  if (mocks) {
    const queue = await loadQueuedDoseCheckOffs(storage);
    const baseSnapshot = getOrInitMockTodaySnapshot(mocks);
    const snapshot = applyQueuedCheckOffsToSnapshot(baseSnapshot, queue);
    await saveCachedTodaySnapshot(snapshot, storage);
    return {
      ok: true,
      snapshot,
      fromCache: Boolean(deps.isOffline),
      isOffline: Boolean(deps.isOffline),
      queuedCount: queue.length,
    };
  }

  const userId = await resolveUserId(deps);

  if (deps.isOffline) {
    const cached = await loadCachedTodaySnapshot(storage, userId);
    const queue = await loadQueuedDoseCheckOffs(storage, userId);
    if (cached) {
      return {
        ok: true,
        snapshot: cached,
        fromCache: true,
        isOffline: true,
        queuedCount: queue.length,
      };
    }
    return {
      ok: false,
      errorCode: 'NETWORK_ERROR',
      isOffline: true,
    };
  }

  const getClient = deps.getClient ?? getSupabaseClient;

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
      const emptyCircle: Circle = {
        id: '00000000-0000-4000-8000-000000000000',
        name: 'CareCircle',
        careRecipientName: '',
        careRecipientDob: null,
        timezone: 'UTC',
        createdBy: null,
        createdAt: nowFn().toISOString(),
      };
      return {
        ok: true,
        snapshot: {
          circle: emptyCircle,
          memberRole: 'viewer',
          medications: [],
          doseEvents: [],
          appointments: [],
          tasks: [],
          fetchedAt: nowFn().toISOString(),
        },
        fromCache: false,
        isOffline: false,
        queuedCount: 0,
      };
    }

    const rawCircle = { ...(circleRows[0] as Record<string, unknown>) };
    rawCircle.created_at = normalizeIsoTimestamp(rawCircle.created_at);
    const parsedCircleRow = circleRowSchema.parse(rawCircle);
    const circle = circleFromRow(parsedCircleRow);

    const nowMs = nowFn().getTime();
    const windowStart = new Date(nowMs - DOSE_WINDOW_HOURS * 3_600_000).toISOString();
    const windowEnd = new Date(nowMs + DOSE_WINDOW_HOURS * 3_600_000).toISOString();

    // The role must be the signed-in user's own row. Every member can read every member row of
    // the circle, so "the first row" is often someone else's role (a viewer would get the
    // owner's Given and Skip buttons).
    const [roleRes, medsRes, dosesRes, apptsRes, tasksRes] = await Promise.all([
      fetchSignedInMemberRole(client, circle.id, userId),
      client.from('medications').select('*').eq('circle_id', circle.id),
      client
        .from('dose_events')
        .select('*')
        .eq('circle_id', circle.id)
        .gte('due_at', windowStart)
        .lte('due_at', windowEnd),
      client.from('appointments').select('*').eq('circle_id', circle.id),
      client.from('tasks').select('*').eq('circle_id', circle.id),
    ]);

    if (roleRes.error) {
      throw new Error(roleRes.error.message);
    }
    for (const res of [medsRes, dosesRes, apptsRes, tasksRes]) {
      if (res.error) {
        throw new Error(res.error.message);
      }
    }

    const memberRole: MemberRole = roleRes.role;

    const medications = (Array.isArray(medsRes.data) ? medsRes.data : []).map((row) =>
      medicationFromRow(medicationRowSchema.parse(row)),
    );

    const doseEvents = (Array.isArray(dosesRes.data) ? dosesRes.data : []).map((row) => {
      const normalized = { ...(row as Record<string, unknown>) };
      normalized.due_at = normalizeIsoTimestamp(normalized.due_at);
      normalized.acted_at = normalizeIsoTimestamp(normalized.acted_at);
      return doseEventFromRow(doseEventRowSchema.parse(normalized));
    });

    const appointments = (Array.isArray(apptsRes.data) ? apptsRes.data : []).map((row) => {
      const normalized = { ...(row as Record<string, unknown>) };
      normalized.starts_at = normalizeIsoTimestamp(normalized.starts_at);
      normalized.ends_at = normalizeIsoTimestamp(normalized.ends_at);
      return appointmentFromRow(appointmentRowSchema.parse(normalized));
    });

    const tasks = (Array.isArray(tasksRes.data) ? tasksRes.data : []).map((row) => {
      const normalized = { ...(row as Record<string, unknown>) };
      normalized.due_at = normalizeIsoTimestamp(normalized.due_at);
      normalized.done_at = normalizeIsoTimestamp(normalized.done_at);
      return taskFromRow(taskRowSchema.parse(normalized));
    });

    const queue = await loadQueuedDoseCheckOffs(storage, userId);
    const rawSnapshot: TodaySnapshot = {
      circle,
      memberRole,
      medications,
      doseEvents,
      appointments,
      tasks,
      fetchedAt: nowFn().toISOString(),
      userId,
    };
    const snapshot = applyQueuedCheckOffsToSnapshot(rawSnapshot, queue);
    await saveCachedTodaySnapshot(snapshot, storage);

    return {
      ok: true,
      snapshot,
      fromCache: false,
      isOffline: false,
      queuedCount: queue.length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const offline = isNetworkFailureMessage(message);
    const cached = await loadCachedTodaySnapshot(storage, userId);
    const queue = await loadQueuedDoseCheckOffs(storage, userId);
    if (cached) {
      return {
        ok: true,
        snapshot: cached,
        fromCache: true,
        isOffline: true,
        queuedCount: queue.length,
      };
    }
    return {
      ok: false,
      errorCode: offline ? 'NETWORK_ERROR' : 'LOAD_TODAY_FAILED',
      isOffline: offline,
    };
  }
}

export type CheckOffDoseResult =
  | {
      ok: true;
      doseEventId: string;
      status: TodayDoseStatusAction;
      queued: boolean;
      queuedCount: number;
    }
  | {
      ok: false;
      errorCode: 'INVALID_STATUS' | 'FORBIDDEN_ROLE' | 'CHECKOFF_FAILED';
    };

async function updateCachedDoseStatus(
  doseEventId: string,
  status: TodayDoseStatusAction,
  actedAt: string,
  storage: TodayStorageAdapter,
  userId?: string | null,
): Promise<void> {
  const cached = await loadCachedTodaySnapshot(storage, userId);
  if (!cached) return;
  const updated: TodaySnapshot = {
    ...cached,
    doseEvents: cached.doseEvents.map((dose) =>
      dose.id === doseEventId ? { ...dose, status, actedAt } : dose,
    ),
  };
  await saveCachedTodaySnapshot(updated, storage);
}

async function enqueueCheckOffItem(
  item: QueuedDoseCheckOff,
  storage: TodayStorageAdapter,
): Promise<QueuedDoseCheckOff[]> {
  const existing = await loadQueuedDoseCheckOffs(storage);
  const filtered = existing.filter(
    (entry) =>
      !(entry.doseEventId === item.doseEventId && (entry.userId ?? null) === (item.userId ?? null)),
  );
  const nextQueue = [...filtered, item];
  await saveQueuedDoseCheckOffs(nextQueue, storage);
  return nextQueue.filter((entry) => (entry.userId ?? null) === (item.userId ?? null));
}

export async function checkOffDose(
  input: {
    doseEventId: string;
    status: TodayDoseStatusAction;
    memberRole?: MemberRole;
  },
  deps: TodayDeps = {},
): Promise<CheckOffDoseResult> {
  const statusParsed = todayDoseStatusActionSchema.safeParse(input.status);
  if (!statusParsed.success) {
    return { ok: false, errorCode: 'INVALID_STATUS' };
  }
  if (input.memberRole === 'viewer') {
    return { ok: false, errorCode: 'FORBIDDEN_ROLE' };
  }

  const storage = deps.storage ?? defaultTodayStorage;
  const nowIso = (deps.now ?? (() => new Date()))().toISOString();
  const trackDoseAction = deps.trackDoseAction ?? defaultTrackDoseAction;
  const mocks = loadCareCircleMocks(deps.env);
  const userId = mocks ? null : await resolveUserId(deps);
  const status = statusParsed.data;

  const queueIt = async (): Promise<CheckOffDoseResult> => {
    const queue = await enqueueCheckOffItem(
      { doseEventId: input.doseEventId, status, actedAt: nowIso, userId },
      storage,
    );
    if (mocks && mockSnapshotState) {
      mockSnapshotState = {
        ...mockSnapshotState,
        doseEvents: mockSnapshotState.doseEvents.map((dose) =>
          dose.id === input.doseEventId ? { ...dose, status, actedAt: nowIso } : dose,
        ),
      };
    }
    await updateCachedDoseStatus(input.doseEventId, status, nowIso, storage, userId);
    return {
      ok: true,
      doseEventId: input.doseEventId,
      status,
      queued: true,
      queuedCount: queue.length,
    };
  };

  if (deps.isOffline) {
    return queueIt();
  }

  if (mocks) {
    const base = getOrInitMockTodaySnapshot(mocks);
    mockSnapshotState = {
      ...base,
      doseEvents: base.doseEvents.map((dose) =>
        dose.id === input.doseEventId ? { ...dose, status, actedAt: nowIso } : dose,
      ),
    };
    await saveCachedTodaySnapshot(mockSnapshotState, storage);
    try {
      trackDoseAction(status);
    } catch {
      // Analytics errors must not fail user dose actions.
    }
    const queue = await loadQueuedDoseCheckOffs(storage, null);
    return {
      ok: true,
      doseEventId: input.doseEventId,
      status,
      queued: false,
      queuedCount: queue.length,
    };
  }

  const getClient = deps.getClient ?? getSupabaseClient;

  try {
    const client = getClient();
    const { error } = await client.rpc('set_dose_status', {
      doseEventId: input.doseEventId,
      status,
    });

    if (error) {
      if (isNetworkFailureMessage(error.message ?? '', (error as { code?: string }).code)) {
        return queueIt();
      }
      return { ok: false, errorCode: 'CHECKOFF_FAILED' };
    }

    await updateCachedDoseStatus(input.doseEventId, status, nowIso, storage, userId);
    try {
      trackDoseAction(status);
    } catch {
      // Analytics errors must not fail user dose actions.
    }
    const queue = await loadQueuedDoseCheckOffs(storage, userId);
    return {
      ok: true,
      doseEventId: input.doseEventId,
      status,
      queued: false,
      queuedCount: queue.length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isNetworkFailureMessage(message)) {
      return queueIt();
    }
    return { ok: false, errorCode: 'CHECKOFF_FAILED' };
  }
}

export interface FlushQueuedDoseCheckOffsResult {
  ok: boolean;
  isOffline: boolean;
  flushedCount: number;
  remainingCount: number;
  /**
   * Check-offs the server refused for a reason other than the network (the dose was already
   * recorded or marked missed, the person lost their role, the dose was deleted after a
   * schedule edit). They are removed from the queue, so one refused item can never block the
   * ones behind it, and the screen reloads to show what the server really has.
   */
  refusedCount: number;
}

export async function flushQueuedDoseCheckOffs(
  deps: TodayDeps = {},
): Promise<FlushQueuedDoseCheckOffsResult> {
  const storage = deps.storage ?? defaultTodayStorage;
  const mocks = loadCareCircleMocks(deps.env);
  const userId = mocks ? null : await resolveUserId(deps);
  const all = await loadQueuedDoseCheckOffs(storage);
  // Only the signed-in user's check-offs are sent. Another account's stay queued until that
  // account signs in again on this phone.
  const others = all.filter((item) => (item.userId ?? null) !== userId);
  const queue = all.filter((item) => (item.userId ?? null) === userId);

  if (queue.length === 0) {
    return {
      ok: true,
      isOffline: Boolean(deps.isOffline),
      flushedCount: 0,
      remainingCount: 0,
      refusedCount: 0,
    };
  }

  if (deps.isOffline) {
    return {
      ok: false,
      isOffline: true,
      flushedCount: 0,
      remainingCount: queue.length,
      refusedCount: 0,
    };
  }

  const trackDoseAction = deps.trackDoseAction ?? defaultTrackDoseAction;

  if (mocks) {
    const base = getOrInitMockTodaySnapshot(mocks);
    mockSnapshotState = applyQueuedCheckOffsToSnapshot(base, queue);
    await saveQueuedDoseCheckOffs(others, storage);
    await saveCachedTodaySnapshot(mockSnapshotState, storage);
    for (const item of queue) {
      try {
        trackDoseAction(item.status);
      } catch {
        // Ignore analytics failure.
      }
    }
    return {
      ok: true,
      isOffline: false,
      flushedCount: queue.length,
      remainingCount: 0,
      refusedCount: 0,
    };
  }

  const getClient = deps.getClient ?? getSupabaseClient;
  const remaining = [...queue];
  let flushedCount = 0;
  let refusedCount = 0;

  const stopOffline = async (isOffline: boolean): Promise<FlushQueuedDoseCheckOffsResult> => {
    await saveQueuedDoseCheckOffs([...others, ...remaining], storage);
    return {
      ok: false,
      isOffline,
      flushedCount,
      remainingCount: remaining.length,
      refusedCount,
    };
  };

  while (remaining.length > 0) {
    const current = remaining[0]!;
    let error: { message?: string; code?: string } | null;
    try {
      const client = getClient();
      ({ error } = await client.rpc('set_dose_status', {
        doseEventId: current.doseEventId,
        status: current.status,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isNetworkFailureMessage(message)) {
        return stopOffline(true);
      }
      error = { message };
    }

    if (error && isNetworkFailureMessage(error.message ?? '', error.code)) {
      return stopOffline(true);
    }

    remaining.shift();
    await saveQueuedDoseCheckOffs([...others, ...remaining], storage);
    if (error) {
      refusedCount += 1;
      continue;
    }
    flushedCount += 1;
    try {
      trackDoseAction(current.status);
    } catch {
      // Ignore analytics failure.
    }
  }

  return { ok: true, isOffline: false, flushedCount, remainingCount: 0, refusedCount };
}

export type LogPrnDoseErrorCode =
  | 'FORBIDDEN_ROLE'
  | 'VALIDATION_ERROR'
  | 'OFFLINE'
  | 'DUPLICATE_PRN_DOSE'
  | 'NOT_AS_NEEDED'
  | 'MEDICATION_INACTIVE'
  | 'PRN_FAILED';

export type LogPrnDoseResult =
  | {
      ok: true;
      doseEvent: DoseEvent;
    }
  | {
      ok: false;
      errorCode: LogPrnDoseErrorCode;
      isOffline: boolean;
    };

function createMockPrnDoseId(): string {
  const g = globalThis as unknown as {
    crypto?: { randomUUID?: () => string };
    expo?: { uuidv4?: () => string };
  };
  const candidate = g.crypto?.randomUUID?.() ?? g.expo?.uuidv4?.();
  if (typeof candidate === 'string' && candidate.length > 0) {
    return candidate.toLowerCase();
  }
  return 'c2cd0099-0000-4000-8000-' + String(Date.now()).slice(-12).padStart(12, '0');
}

async function appendCachedDoseEvent(
  doseEvent: DoseEvent,
  storage: TodayStorageAdapter,
  userId?: string | null,
): Promise<void> {
  const cached = await loadCachedTodaySnapshot(storage, userId);
  if (!cached) return;
  const exists = cached.doseEvents.some((d) => d.id === doseEvent.id);
  const updated: TodaySnapshot = {
    ...cached,
    doseEvents: exists
      ? cached.doseEvents.map((d) => (d.id === doseEvent.id ? doseEvent : d))
      : [...cached.doseEvents, doseEvent],
  };
  await saveCachedTodaySnapshot(updated, storage);
}

/**
 * Records an as-needed (`as_needed`) dose immediately on the server via `public.log_prn_dose`.
 * Never queues offline taps because `log_prn_dose` stamps `due_at` and `acted_at` from the
 * server's `now()`, and replaying later would record the wrong dose time.
 */
export async function logPrnDose(
  input: {
    medicationId: string;
    memberRole?: MemberRole;
  },
  deps: TodayDeps = {},
): Promise<LogPrnDoseResult> {
  if (input.memberRole === 'viewer') {
    return { ok: false, errorCode: 'FORBIDDEN_ROLE', isOffline: false };
  }

  const medicationId = input.medicationId.trim();
  if (!medicationId) {
    return { ok: false, errorCode: 'VALIDATION_ERROR', isOffline: false };
  }

  if (deps.isOffline) {
    return { ok: false, errorCode: 'OFFLINE', isOffline: true };
  }

  const storage = deps.storage ?? defaultTodayStorage;
  const trackDoseAction = deps.trackDoseAction ?? defaultTrackDoseAction;
  const mocks = loadCareCircleMocks(deps.env);

  if (mocks) {
    const base = getOrInitMockTodaySnapshot(mocks);
    const med = base.medications.find((m) => m.id === medicationId);
    if (!med) {
      return { ok: false, errorCode: 'PRN_FAILED', isOffline: false };
    }
    if (!med.active) {
      return { ok: false, errorCode: 'MEDICATION_INACTIVE', isOffline: false };
    }
    if (med.schedule.kind !== 'as_needed') {
      return { ok: false, errorCode: 'NOT_AS_NEEDED', isOffline: false };
    }
    const nowIso = (deps.now ?? (() => new Date()))().toISOString();
    const created: DoseEvent = {
      id: createMockPrnDoseId(),
      medicationId,
      circleId: base.circle.id,
      dueAt: nowIso,
      status: 'given',
      actedBy: base.circle.createdBy,
      actedAt: nowIso,
    };
    mockSnapshotState = {
      ...base,
      doseEvents: [...base.doseEvents, created],
    };
    await saveCachedTodaySnapshot(mockSnapshotState, storage);
    try {
      trackDoseAction('given');
    } catch {
      // Analytics errors must not fail user dose actions.
    }
    return { ok: true, doseEvent: created };
  }

  const userId = await resolveUserId(deps);
  const getClient = deps.getClient ?? getSupabaseClient;

  try {
    const client = getClient();
    const { data, error } = await client.rpc('log_prn_dose', { medicationId });

    if (error) {
      const msg = error.message ?? '';
      const code = (error as { code?: string }).code;
      if (isNetworkFailureMessage(msg, code)) {
        return { ok: false, errorCode: 'OFFLINE', isOffline: true };
      }
      if (msg.includes('DUPLICATE_PRN_DOSE')) {
        return { ok: false, errorCode: 'DUPLICATE_PRN_DOSE', isOffline: false };
      }
      if (msg.includes('NOT_AS_NEEDED')) {
        return { ok: false, errorCode: 'NOT_AS_NEEDED', isOffline: false };
      }
      if (msg.includes('MEDICATION_INACTIVE')) {
        return { ok: false, errorCode: 'MEDICATION_INACTIVE', isOffline: false };
      }
      return { ok: false, errorCode: 'PRN_FAILED', isOffline: false };
    }

    const rawCandidate = Array.isArray(data) ? data[0] : data;
    if (!rawCandidate || typeof rawCandidate !== 'object') {
      return { ok: false, errorCode: 'PRN_FAILED', isOffline: false };
    }
    const rawRow = { ...(rawCandidate as Record<string, unknown>) };
    rawRow.due_at = normalizeIsoTimestamp(rawRow.due_at);
    rawRow.acted_at = normalizeIsoTimestamp(rawRow.acted_at);
    const parsed = doseEventRowSchema.safeParse(rawRow);
    if (!parsed.success) {
      return { ok: false, errorCode: 'PRN_FAILED', isOffline: false };
    }

    const doseEvent = doseEventFromRow(parsed.data);
    await appendCachedDoseEvent(doseEvent, storage, userId);
    try {
      trackDoseAction('given');
    } catch {
      // Analytics errors must not fail user dose actions.
    }
    return { ok: true, doseEvent };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isNetworkFailureMessage(message)) {
      return { ok: false, errorCode: 'OFFLINE', isOffline: true };
    }
    return { ok: false, errorCode: 'PRN_FAILED', isOffline: false };
  }
}
