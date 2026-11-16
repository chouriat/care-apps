import {
  doseEventRowSchema,
  validateAnalyticsEvent,
  type DoseEvent,
  type DoseStatus,
} from '@carecircle/core';
import { getSupabaseClient } from '../auth/api';
import { getAppObservability } from '../observability/api';
import {
  defaultTodayStorage,
  loadCachedTodaySnapshot,
  saveCachedTodaySnapshot,
  type TodaySnapshot,
  type TodayStorageAdapter,
} from './api';

export interface PostgresChangesFilter {
  event: '*' | 'INSERT' | 'UPDATE' | 'DELETE';
  schema: string;
  table: string;
  filter?: string;
}

export interface PostgresChangesPayload {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new: Record<string, unknown>;
  old?: Record<string, unknown>;
}

export interface RealtimeChannelLike {
  on: (
    type: 'postgres_changes',
    filter: PostgresChangesFilter,
    callback: (payload: PostgresChangesPayload) => void,
  ) => RealtimeChannelLike;
  subscribe: () => RealtimeChannelLike;
  unsubscribe?: () => Promise<unknown> | unknown;
}

export interface RealtimeSupabaseClientLike {
  channel: (name: string) => RealtimeChannelLike;
  removeChannel?: (channel: RealtimeChannelLike) => Promise<unknown> | unknown;
}

export interface SubscribeToCircleDoseEventsOptions {
  circleId: string;
  getClient?: () => RealtimeSupabaseClientLike;
  storage?: TodayStorageAdapter;
  userId?: string | null;
  onDoseEventChange?: (dose: DoseEvent, meta: { newlyMissed: boolean }) => void;
  trackDoseMissed?: (missedCount: number) => void;
}

function normalizeIsoTimestamp(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

export function parseRealtimeDoseRow(rawRow: unknown): DoseEvent | null {
  if (!rawRow || typeof rawRow !== 'object' || Array.isArray(rawRow)) {
    return null;
  }
  const rec = rawRow as Record<string, unknown>;
  const normalized = {
    ...rec,
    due_at: normalizeIsoTimestamp(rec.due_at),
    acted_at: rec.acted_at === null ? null : normalizeIsoTimestamp(rec.acted_at),
  };
  const parsed = doseEventRowSchema.safeParse(normalized);
  if (!parsed.success) {
    return null;
  }
  return {
    id: parsed.data.id,
    medicationId: parsed.data.medication_id,
    circleId: parsed.data.circle_id,
    dueAt: parsed.data.due_at,
    status: parsed.data.status,
    actedBy: parsed.data.acted_by,
    actedAt: parsed.data.acted_at,
  };
}

export function applyRealtimeDoseUpdateToSnapshot(
  snapshot: TodaySnapshot,
  rawRow: unknown,
  oldRow?: Record<string, unknown>,
): { snapshot: TodaySnapshot; newlyMissed: boolean; updatedDose: DoseEvent | null } {
  const updatedDose = parseRealtimeDoseRow(rawRow);
  if (!updatedDose || updatedDose.circleId !== snapshot.circle.id) {
    return { snapshot, newlyMissed: false, updatedDose: null };
  }

  const existing = snapshot.doseEvents.find((d) => d.id === updatedDose.id);
  const previousStatus: DoseStatus | undefined =
    existing?.status ??
    (typeof oldRow?.status === 'string' ? (oldRow.status as DoseStatus) : undefined);
  const newlyMissed = updatedDose.status === 'missed' && previousStatus === 'pending';

  const nextDoseEvents = existing
    ? snapshot.doseEvents.map((d) => (d.id === updatedDose.id ? updatedDose : d))
    : [...snapshot.doseEvents, updatedDose];

  return {
    snapshot: {
      ...snapshot,
      doseEvents: nextDoseEvents,
    },
    newlyMissed,
    updatedDose,
  };
}

function defaultTrackDoseMissed(missedCount: number): void {
  const validated = validateAnalyticsEvent('cc_dose_missed', { missedCount }) as {
    missedCount: number;
  };
  void getAppObservability()
    .analytics.track('cc_dose_missed', validated)
    .catch(() => undefined);
}

export function subscribeToCircleDoseEvents(
  options: SubscribeToCircleDoseEventsOptions,
): () => void {
  const { circleId, storage = defaultTodayStorage, userId } = options;
  const getClient =
    options.getClient ?? (() => getSupabaseClient() as unknown as RealtimeSupabaseClientLike);
  const trackDoseMissed = options.trackDoseMissed ?? defaultTrackDoseMissed;

  let active = true;
  let workQueue: Promise<void> = Promise.resolve();

  const handlePayload = (payload: PostgresChangesPayload): void => {
    if (!active) return;
    if (!payload || payload.eventType === 'DELETE') return;

    const updatedDose = parseRealtimeDoseRow(payload.new);
    if (!updatedDose || updatedDose.circleId !== circleId) {
      return;
    }

    workQueue = workQueue
      .then(async () => {
        if (!active) return;
        const cached = await loadCachedTodaySnapshot(storage, userId);
        if (!active) return;

        const existing = cached?.doseEvents.find((d) => d.id === updatedDose.id);
        const previousStatus =
          existing?.status ??
          (typeof payload.old?.status === 'string' ? payload.old.status : undefined);
        const newlyMissed = updatedDose.status === 'missed' && previousStatus === 'pending';

        if (cached && cached.circle.id === circleId) {
          const nextDoseEvents = existing
            ? cached.doseEvents.map((d) => (d.id === updatedDose.id ? updatedDose : d))
            : [...cached.doseEvents, updatedDose];
          await saveCachedTodaySnapshot(
            {
              ...cached,
              doseEvents: nextDoseEvents,
            },
            storage,
          );
        }

        if (!active) return;
        if (newlyMissed) {
          try {
            trackDoseMissed(1);
          } catch {
            // Analytics errors must not interrupt realtime updates.
          }
        }

        options.onDoseEventChange?.(updatedDose, { newlyMissed });
      })
      .catch(() => undefined);
  };

  const client = getClient();
  const channel = client
    .channel(`circle-dose-events:${circleId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'dose_events',
        filter: `circle_id=eq.${circleId}`,
      },
      handlePayload,
    )
    .subscribe();

  return () => {
    if (!active) return;
    active = false;
    try {
      void channel.unsubscribe?.();
    } catch {
      // Ignore cleanup errors on unmount.
    }
    try {
      void client.removeChannel?.(channel);
    } catch {
      // Ignore cleanup errors on unmount.
    }
  };
}
