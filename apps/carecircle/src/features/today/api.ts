import {
  appointmentRowSchema,
  appointmentSchema,
  circleRowSchema,
  circleSchema,
  doseEventRowSchema,
  doseEventSchema,
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
import { z } from 'zod';
import { getSupabaseClient } from '../auth/api';
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

export const todaySnapshotSchema = z
  .object({
    circle: circleSchema,
    memberRole: memberRoleSchema,
    medications: z.array(medicationSchema),
    doseEvents: z.array(doseEventSchema),
    appointments: z.array(appointmentSchema),
    tasks: z.array(taskSchema),
    fetchedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type TodaySnapshot = z.infer<typeof todaySnapshotSchema>;

export const queuedDoseCheckOffSchema = z
  .object({
    doseEventId: z.string().uuid(),
    status: todayDoseStatusActionSchema,
    actedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type QueuedDoseCheckOff = z.infer<typeof queuedDoseCheckOffSchema>;

export interface TodayAgenda {
  localDate: string;
  timezone: string;
  memberRole: MemberRole;
  doseGroups: TodayDoseGroup[];
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

export const defaultTodayStorage: TodayStorageAdapter = {
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

export function selectTodayAgenda(snapshot: TodaySnapshot, now: Date = new Date()): TodayAgenda {
  const timezone = snapshot.circle.timezone;
  const localDate = formatLocalDateInZone(now, timezone);
  const medById = new Map<string, Medication>(
    snapshot.medications.map((med) => [med.id, med] as const),
  );

  const todayDoseItems: TodayDoseItem[] = [];
  for (const dose of snapshot.doseEvents) {
    if (formatLocalDateInZone(dose.dueAt, timezone) !== localDate) {
      continue;
    }
    const med = medById.get(dose.medicationId);
    if (med && !med.active) {
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

  const isEmpty = doseGroups.length === 0 && nextAppointment === null && tasksDueToday.length === 0;

  return {
    localDate,
    timezone,
    memberRole: snapshot.memberRole,
    doseGroups,
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
): Promise<QueuedDoseCheckOff[]> {
  try {
    const raw = await storage.getItem(TODAY_CHECKOFF_QUEUE_KEY);
    if (!raw) return [];
    const parsed = z.array(queuedDoseCheckOffSchema).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
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
): Promise<TodaySnapshot | null> {
  try {
    const raw = await storage.getItem(TODAY_SNAPSHOT_CACHE_KEY);
    if (!raw) return null;
    const parsed = todaySnapshotSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const queue = await loadQueuedDoseCheckOffs(storage);
    return applyQueuedCheckOffsToSnapshot(parsed.data, queue);
  } catch {
    return null;
  }
}

function isNetworkFailureMessage(message: string, code?: string): boolean {
  if (code === 'NETWORK_ERROR') {
    return true;
  }
  return /network|fetch failed|failed to fetch|offline|load failed/i.test(message);
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
  storage?: TodayStorageAdapter;
  env?: Record<string, string | undefined>;
  isOffline?: boolean;
  now?: () => Date;
  trackDoseAction?: (status: TodayDoseStatusAction) => void;
}

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

  if (deps.isOffline) {
    const cached = await loadCachedTodaySnapshot(storage);
    const queue = await loadQueuedDoseCheckOffs(storage);
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
    const circlesRes = await client.from('circles').select('*').limit(1);
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
          memberRole: 'owner',
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

    const [membersRes, medsRes, dosesRes, apptsRes, tasksRes] = await Promise.all([
      client.from('circle_members').select('*').eq('circle_id', circle.id),
      client.from('medications').select('*').eq('circle_id', circle.id),
      client.from('dose_events').select('*').eq('circle_id', circle.id),
      client.from('appointments').select('*').eq('circle_id', circle.id),
      client.from('tasks').select('*').eq('circle_id', circle.id),
    ]);

    for (const res of [membersRes, medsRes, dosesRes, apptsRes, tasksRes]) {
      if (res.error) {
        throw new Error(res.error.message);
      }
    }

    const memberRows = Array.isArray(membersRes.data) ? membersRes.data : [];
    const firstRole = (memberRows[0] as { role?: unknown } | undefined)?.role;
    const roleParsed = memberRoleSchema.safeParse(firstRole);
    const memberRole: MemberRole = roleParsed.success ? roleParsed.data : 'owner';

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

    const queue = await loadQueuedDoseCheckOffs(storage);
    const rawSnapshot: TodaySnapshot = {
      circle,
      memberRole,
      medications,
      doseEvents,
      appointments,
      tasks,
      fetchedAt: nowFn().toISOString(),
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
    const cached = await loadCachedTodaySnapshot(storage);
    const queue = await loadQueuedDoseCheckOffs(storage);
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
): Promise<void> {
  const cached = await loadCachedTodaySnapshot(storage);
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
  const filtered = existing.filter((entry) => entry.doseEventId !== item.doseEventId);
  const nextQueue = [...filtered, item];
  await saveQueuedDoseCheckOffs(nextQueue, storage);
  return nextQueue;
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

  if (deps.isOffline) {
    const queue = await enqueueCheckOffItem(
      {
        doseEventId: input.doseEventId,
        status: statusParsed.data,
        actedAt: nowIso,
      },
      storage,
    );
    if (mocks && mockSnapshotState) {
      mockSnapshotState = {
        ...mockSnapshotState,
        doseEvents: mockSnapshotState.doseEvents.map((dose) =>
          dose.id === input.doseEventId
            ? { ...dose, status: statusParsed.data, actedAt: nowIso }
            : dose,
        ),
      };
    }
    await updateCachedDoseStatus(input.doseEventId, statusParsed.data, nowIso, storage);
    return {
      ok: true,
      doseEventId: input.doseEventId,
      status: statusParsed.data,
      queued: true,
      queuedCount: queue.length,
    };
  }

  if (mocks) {
    const base = getOrInitMockTodaySnapshot(mocks);
    mockSnapshotState = {
      ...base,
      doseEvents: base.doseEvents.map((dose) =>
        dose.id === input.doseEventId
          ? { ...dose, status: statusParsed.data, actedAt: nowIso }
          : dose,
      ),
    };
    await saveCachedTodaySnapshot(mockSnapshotState, storage);
    try {
      trackDoseAction(statusParsed.data);
    } catch {
      // Analytics errors must not fail user dose actions.
    }
    const queue = await loadQueuedDoseCheckOffs(storage);
    return {
      ok: true,
      doseEventId: input.doseEventId,
      status: statusParsed.data,
      queued: false,
      queuedCount: queue.length,
    };
  }

  const getClient = deps.getClient ?? getSupabaseClient;

  try {
    const client = getClient();
    const { error } = await client.rpc('set_dose_status', {
      doseEventId: input.doseEventId,
      status: statusParsed.data,
    });

    if (error) {
      if (isNetworkFailureMessage(error.message ?? '', (error as { code?: string }).code)) {
        const queue = await enqueueCheckOffItem(
          {
            doseEventId: input.doseEventId,
            status: statusParsed.data,
            actedAt: nowIso,
          },
          storage,
        );
        await updateCachedDoseStatus(input.doseEventId, statusParsed.data, nowIso, storage);
        return {
          ok: true,
          doseEventId: input.doseEventId,
          status: statusParsed.data,
          queued: true,
          queuedCount: queue.length,
        };
      }
      return { ok: false, errorCode: 'CHECKOFF_FAILED' };
    }

    await updateCachedDoseStatus(input.doseEventId, statusParsed.data, nowIso, storage);
    try {
      trackDoseAction(statusParsed.data);
    } catch {
      // Analytics errors must not fail user dose actions.
    }
    const queue = await loadQueuedDoseCheckOffs(storage);
    return {
      ok: true,
      doseEventId: input.doseEventId,
      status: statusParsed.data,
      queued: false,
      queuedCount: queue.length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isNetworkFailureMessage(message)) {
      const queue = await enqueueCheckOffItem(
        {
          doseEventId: input.doseEventId,
          status: statusParsed.data,
          actedAt: nowIso,
        },
        storage,
      );
      await updateCachedDoseStatus(input.doseEventId, statusParsed.data, nowIso, storage);
      return {
        ok: true,
        doseEventId: input.doseEventId,
        status: statusParsed.data,
        queued: true,
        queuedCount: queue.length,
      };
    }
    return { ok: false, errorCode: 'CHECKOFF_FAILED' };
  }
}

export interface FlushQueuedDoseCheckOffsResult {
  ok: boolean;
  isOffline: boolean;
  flushedCount: number;
  remainingCount: number;
}

export async function flushQueuedDoseCheckOffs(
  deps: TodayDeps = {},
): Promise<FlushQueuedDoseCheckOffsResult> {
  const storage = deps.storage ?? defaultTodayStorage;
  const queue = await loadQueuedDoseCheckOffs(storage);

  if (queue.length === 0) {
    return { ok: true, isOffline: Boolean(deps.isOffline), flushedCount: 0, remainingCount: 0 };
  }

  if (deps.isOffline) {
    return { ok: false, isOffline: true, flushedCount: 0, remainingCount: queue.length };
  }

  const mocks = loadCareCircleMocks(deps.env);
  const trackDoseAction = deps.trackDoseAction ?? defaultTrackDoseAction;

  if (mocks) {
    const base = getOrInitMockTodaySnapshot(mocks);
    mockSnapshotState = applyQueuedCheckOffsToSnapshot(base, queue);
    await saveQueuedDoseCheckOffs([], storage);
    await saveCachedTodaySnapshot(mockSnapshotState, storage);
    for (const item of queue) {
      try {
        trackDoseAction(item.status);
      } catch {
        // Ignore analytics failure.
      }
    }
    return { ok: true, isOffline: false, flushedCount: queue.length, remainingCount: 0 };
  }

  const getClient = deps.getClient ?? getSupabaseClient;
  const remaining = [...queue];
  let flushedCount = 0;

  while (remaining.length > 0) {
    const current = remaining[0]!;
    try {
      const client = getClient();
      const { error } = await client.rpc('set_dose_status', {
        doseEventId: current.doseEventId,
        status: current.status,
      });

      if (error) {
        const isNet = isNetworkFailureMessage(
          error.message ?? '',
          (error as { code?: string }).code,
        );
        await saveQueuedDoseCheckOffs(remaining, storage);
        return {
          ok: false,
          isOffline: isNet,
          flushedCount,
          remainingCount: remaining.length,
        };
      }

      remaining.shift();
      flushedCount += 1;
      await saveQueuedDoseCheckOffs(remaining, storage);
      try {
        trackDoseAction(current.status);
      } catch {
        // Ignore analytics failure.
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await saveQueuedDoseCheckOffs(remaining, storage);
      return {
        ok: false,
        isOffline: isNetworkFailureMessage(message),
        flushedCount,
        remainingCount: remaining.length,
      };
    }
  }

  return { ok: true, isOffline: false, flushedCount, remainingCount: 0 };
}
