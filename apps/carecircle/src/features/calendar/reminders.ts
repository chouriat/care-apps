import {
  scheduleLocalReminder,
  type Appointment,
  type LocalNotificationAdapter,
  type ScheduledLocalReminder,
} from '@carecircle/core';
import en from '../../../i18n/en.json';
import { createExpoLocalNotificationAdapter } from '../notifications/api';

export type AppointmentReminderKind = '24h' | '2h';

const HOURS_24_MS = 24 * 3_600_000;
const HOURS_2_MS = 2 * 3_600_000;

export interface AppointmentReminderSpec {
  kind: AppointmentReminderKind;
  identifier: string;
  triggerAtMs: number;
  triggerDate: Date;
  utcDate: string;
  utcTime: string;
  title: string;
  body: string;
  data: Record<string, string>;
}

export function appointmentReminderIdentifier(
  appointmentId: string,
  kind: AppointmentReminderKind,
): string {
  return `appointment-${kind}:${appointmentId}`;
}

function formatUtcDateAndTime(utcMs: number): { utcDate: string; utcTime: string } {
  const d = new Date(utcMs);
  const year = String(d.getUTCFullYear()).padStart(4, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hour = String(d.getUTCHours()).padStart(2, '0');
  const minute = String(d.getUTCMinutes()).padStart(2, '0');
  return {
    utcDate: `${year}-${month}-${day}`,
    utcTime: `${hour}:${minute}`,
  };
}

/**
 * Computes the 24-hour-before and 2-hour-before local notification specs for an appointment,
 * filtering out any reminder whose trigger time is in the past (`<= now`).
 *
 * Subtracting 24h (`86_400_000` ms) and 2h (`7_200_000` ms) from the UTC `startsAt` instant
 * guarantees that reminders fire at the exact 24h and 2h lead times even across DST transitions.
 */
export function computeAppointmentReminderSpecs(
  appointment: Pick<Appointment, 'id' | 'circleId' | 'title' | 'startsAt'>,
  now: Date = new Date(),
): AppointmentReminderSpec[] {
  const startsAtMs = new Date(appointment.startsAt).getTime();
  if (!Number.isFinite(startsAtMs)) {
    return [];
  }
  const nowMs = now.getTime();
  const cleanTitle = appointment.title.trim() || en.calendar.title;

  const candidates: Array<{
    kind: AppointmentReminderKind;
    offsetMs: number;
    notificationTitle: string;
    dataType: string;
  }> = [
    {
      kind: '24h',
      offsetMs: HOURS_24_MS,
      notificationTitle: en.notifications.appointmentTomorrowTitle,
      dataType: 'appointment_24h',
    },
    {
      kind: '2h',
      offsetMs: HOURS_2_MS,
      notificationTitle: en.notifications.appointment2hTitle,
      dataType: 'appointment_2h',
    },
  ];

  const specs: AppointmentReminderSpec[] = [];
  for (const candidate of candidates) {
    const triggerAtMs = startsAtMs - candidate.offsetMs;
    if (triggerAtMs <= nowMs) {
      continue;
    }
    const { utcDate, utcTime } = formatUtcDateAndTime(triggerAtMs);
    specs.push({
      kind: candidate.kind,
      identifier: appointmentReminderIdentifier(appointment.id, candidate.kind),
      triggerAtMs,
      triggerDate: new Date(triggerAtMs),
      utcDate,
      utcTime,
      title: candidate.notificationTitle,
      body: cleanTitle,
      data: {
        appointmentId: appointment.id,
        circleId: appointment.circleId,
        type: candidate.dataType,
      },
    });
  }

  return specs;
}

export async function cancelAppointmentReminders(
  appointmentId: string,
  adapter: LocalNotificationAdapter = createExpoLocalNotificationAdapter(),
): Promise<void> {
  for (const kind of ['24h', '2h'] as const) {
    try {
      await adapter.cancelScheduledNotificationAsync(
        appointmentReminderIdentifier(appointmentId, kind),
      );
    } catch {
      // Never block an appointment write or realtime update if local notification cancellation fails.
    }
  }
}

export async function syncAppointmentReminders(
  appointment: Pick<Appointment, 'id' | 'circleId' | 'title' | 'startsAt'>,
  options: {
    adapter?: LocalNotificationAdapter;
    now?: Date;
  } = {},
): Promise<ScheduledLocalReminder[]> {
  const adapter = options.adapter ?? createExpoLocalNotificationAdapter();
  const now = options.now ?? new Date();

  await cancelAppointmentReminders(appointment.id, adapter);

  const specs = computeAppointmentReminderSpecs(appointment, now);
  const scheduled: ScheduledLocalReminder[] = [];
  for (const spec of specs) {
    try {
      const res = await scheduleLocalReminder(adapter, {
        identifier: spec.identifier,
        date: spec.utcDate,
        time: spec.utcTime,
        timeZone: 'UTC',
        title: spec.title,
        body: spec.body,
        data: spec.data,
      });
      scheduled.push(res);
    } catch {
      // Never fail an appointment save if OS notification permissions are denied or unavailable.
    }
  }

  return scheduled;
}

export async function syncAllAppointmentReminders(
  appointments: ReadonlyArray<Pick<Appointment, 'id' | 'circleId' | 'title' | 'startsAt'>>,
  options: {
    adapter?: LocalNotificationAdapter;
    now?: Date;
  } = {},
): Promise<void> {
  for (const appt of appointments) {
    await syncAppointmentReminders(appt, options);
  }
}
