import {
  appointmentRowSchema,
  type Appointment,
  type LocalNotificationAdapter,
} from '@carecircle/core';
import { getSupabaseClient } from '../auth/api';
import type { PostgresChangesPayload, RealtimeSupabaseClientLike } from '../today/realtime';
import { requestTodayReload } from '../today/refresh';
import { cancelAppointmentReminders, syncAppointmentReminders } from './reminders';

export interface SubscribeToCircleAppointmentsOptions {
  circleId: string;
  getClient?: () => RealtimeSupabaseClientLike;
  notificationAdapter?: LocalNotificationAdapter;
  now?: () => Date;
  onAppointmentUpsert?: (appointment: Appointment) => void;
  onAppointmentDelete?: (appointmentId: string) => void;
}

function normalizeIsoTimestamp(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

export function parseRealtimeAppointmentRow(rawRow: unknown): Appointment | null {
  if (!rawRow || typeof rawRow !== 'object' || Array.isArray(rawRow)) {
    return null;
  }
  const rec = rawRow as Record<string, unknown>;
  const normalized = {
    ...rec,
    starts_at: normalizeIsoTimestamp(rec.starts_at),
    ends_at:
      rec.ends_at === null || rec.ends_at === undefined ? null : normalizeIsoTimestamp(rec.ends_at),
    location: rec.location ?? null,
    driver_user_id: rec.driver_user_id ?? null,
    notes: rec.notes ?? null,
  };
  const parsed = appointmentRowSchema.safeParse(normalized);
  if (!parsed.success) {
    return null;
  }
  return {
    id: parsed.data.id,
    circleId: parsed.data.circle_id,
    title: parsed.data.title,
    startsAt: parsed.data.starts_at,
    endsAt: parsed.data.ends_at,
    location: parsed.data.location,
    driverUserId: parsed.data.driver_user_id,
    notes: parsed.data.notes,
  };
}

export function subscribeToCircleAppointments(
  options: SubscribeToCircleAppointmentsOptions,
): () => void {
  const { circleId } = options;
  const getClient =
    options.getClient ?? (() => getSupabaseClient() as unknown as RealtimeSupabaseClientLike);
  const nowFn = options.now ?? (() => new Date());

  let active = true;

  const handlePayload = (payload: PostgresChangesPayload): void => {
    if (!active || !payload) return;

    if (payload.eventType === 'DELETE') {
      const deletedId =
        typeof payload.old?.id === 'string'
          ? payload.old.id
          : typeof payload.new?.id === 'string'
            ? payload.new.id
            : null;
      if (!deletedId) return;
      if (options.notificationAdapter) {
        void cancelAppointmentReminders(deletedId, options.notificationAdapter);
      } else {
        void cancelAppointmentReminders(deletedId);
      }
      options.onAppointmentDelete?.(deletedId);
      requestTodayReload();
      return;
    }

    const updated = parseRealtimeAppointmentRow(payload.new);
    if (!updated || updated.circleId !== circleId) {
      return;
    }

    void syncAppointmentReminders(updated, {
      ...(options.notificationAdapter ? { adapter: options.notificationAdapter } : {}),
      now: nowFn(),
    });
    options.onAppointmentUpsert?.(updated);
    requestTodayReload();
  };

  const client = getClient();
  const channel = client
    .channel(`circle-appointments:${circleId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'appointments',
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
