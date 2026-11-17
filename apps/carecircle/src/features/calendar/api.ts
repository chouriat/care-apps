import {
  appointmentRowSchema,
  circleMemberRowSchema,
  circleRowSchema,
  computeUtcTriggerForLocalTime,
  type Appointment,
  type AppointmentRow,
  type Circle,
  type CircleRow,
  type LocalNotificationAdapter,
  type MemberRole,
} from '@carecircle/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import en from '../../../i18n/en.json';
import { getSupabaseClient } from '../auth/api';
import { fetchSignedInMemberRole } from '../circle/api';
import { loadCareCircleMocks } from '../mocks';
import {
  DEFAULT_MOCK_NOW_ISO,
  formatLocalDateInZone,
  formatLocalTimeInZone,
  getOrInitMockTodaySnapshot,
  loadTodaySnapshot,
  type TodayDeps,
} from '../today/api';
import { requestTodayReload } from '../today/refresh';
import {
  cancelAppointmentReminders,
  syncAllAppointmentReminders,
  syncAppointmentReminders,
} from './reminders';

export interface CalendarMemberOption {
  userId: string;
  role: MemberRole;
  displayName: string;
}

export type CalendarErrorCode =
  | 'VALIDATION_ERROR'
  | 'END_BEFORE_START'
  | 'FORBIDDEN_ROLE'
  | 'NETWORK_ERROR'
  | 'LOAD_CALENDAR_FAILED'
  | 'SAVE_APPOINTMENT_FAILED';

export interface CalendarDeps extends TodayDeps {
  getClient?: () => Pick<SupabaseClient, 'from' | 'rpc'>;
  notificationAdapter?: LocalNotificationAdapter;
}

export interface AppointmentDraftInput {
  circleId: string;
  timezone: string;
  title: string;
  startDate: string;
  startTime: string;
  endDate?: string | null;
  endTime?: string | null;
  location?: string | null;
  notes?: string | null;
  driverUserId?: string | null;
}

export type ValidatedAppointmentPayload = {
  circleId: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  notes: string | null;
  driverUserId: string | null;
};

export function validateAppointmentDraft(
  input: AppointmentDraftInput,
):
  | { ok: true; payload: ValidatedAppointmentPayload }
  | { ok: false; errorCode: 'VALIDATION_ERROR' | 'END_BEFORE_START'; message: string } {
  const title = input.title.trim();
  const startDate = input.startDate.trim();
  const startTime = input.startTime.trim();

  if (!input.circleId.trim() || !title || !startDate || !startTime) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      message: en.calendar.validationError,
    };
  }

  let startTrigger: ReturnType<typeof computeUtcTriggerForLocalTime>;
  try {
    startTrigger = computeUtcTriggerForLocalTime({
      date: startDate,
      time: startTime,
      timeZone: input.timezone,
    });
  } catch {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      message: en.calendar.validationError,
    };
  }

  const rawEndDate = input.endDate?.trim() ?? '';
  const rawEndTime = input.endTime?.trim() ?? '';
  let endsAt: string | null = null;

  if (rawEndDate.length > 0 || rawEndTime.length > 0) {
    const effectiveEndDate = rawEndDate || startDate;
    if (!rawEndTime) {
      return {
        ok: false,
        errorCode: 'VALIDATION_ERROR',
        message: en.calendar.validationError,
      };
    }

    let endTrigger: ReturnType<typeof computeUtcTriggerForLocalTime>;
    try {
      endTrigger = computeUtcTriggerForLocalTime({
        date: effectiveEndDate,
        time: rawEndTime,
        timeZone: input.timezone,
      });
    } catch {
      return {
        ok: false,
        errorCode: 'VALIDATION_ERROR',
        message: en.calendar.validationError,
      };
    }

    if (endTrigger.triggerAtMs <= startTrigger.triggerAtMs) {
      return {
        ok: false,
        errorCode: 'END_BEFORE_START',
        message: en.calendar.endBeforeStartError,
      };
    }

    endsAt = endTrigger.triggerAtIso;
  }

  return {
    ok: true,
    payload: {
      circleId: input.circleId.trim(),
      title,
      startsAt: startTrigger.triggerAtIso,
      endsAt,
      location: input.location?.trim() ? input.location.trim() : null,
      notes: input.notes?.trim() ? input.notes.trim() : null,
      driverUserId: input.driverUserId?.trim() ? input.driverUserId.trim() : null,
    },
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

function isNetworkFailureMessage(message: string, code?: string): boolean {
  if (code === 'NETWORK_ERROR') return true;
  return /network|fetch failed|failed to fetch|offline|load failed/i.test(message);
}

function roleLabel(role: MemberRole): string {
  switch (role) {
    case 'owner':
      return en.circle.roleOwner;
    case 'helper':
      return en.circle.roleHelper;
    default:
      return en.circle.roleViewer;
  }
}

async function resolveUserId(deps: CalendarDeps): Promise<string | null> {
  try {
    if (deps.getUserId) return await deps.getUserId();
    const { data } = await getSupabaseClient().auth.getSession();
    return data.session?.user.id ?? null;
  } catch {
    return null;
  }
}

async function refreshTodayAfterSave(deps: CalendarDeps): Promise<void> {
  try {
    await loadTodaySnapshot(deps);
  } catch {
    // Today reloads on its next open or retry.
  }
  requestTodayReload();
}

export type LoadCalendarResult =
  | {
      ok: true;
      circle: Circle;
      memberRole: MemberRole;
      members: CalendarMemberOption[];
      appointments: Appointment[];
      isOffline: boolean;
    }
  | {
      ok: false;
      errorCode: 'NETWORK_ERROR' | 'LOAD_CALENDAR_FAILED';
      isOffline: boolean;
    };

export async function loadCalendarScreen(deps: CalendarDeps = {}): Promise<LoadCalendarResult> {
  const mocks = loadCareCircleMocks(deps.env);
  const nowFn = deps.now ?? (() => (mocks ? new Date(DEFAULT_MOCK_NOW_ISO) : new Date()));
  const now = nowFn();

  if (mocks) {
    const snapshot = getOrInitMockTodaySnapshot(mocks);
    const members: CalendarMemberOption[] = mocks.members.map((m) => ({
      userId: m.userId,
      role: m.role,
      displayName: `${en.circle.defaultMemberName} (${roleLabel(m.role)})`,
    }));
    const sorted = [...snapshot.appointments].sort(
      (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
    );
    await syncAllAppointmentReminders(sorted, {
      ...(deps.notificationAdapter ? { adapter: deps.notificationAdapter } : {}),
      now,
    });
    return {
      ok: true,
      circle: snapshot.circle,
      memberRole: snapshot.memberRole,
      members,
      appointments: sorted,
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
        members: [],
        appointments: [],
        isOffline: false,
      };
    }

    const rawCircle = { ...(circleRows[0] as Record<string, unknown>) };
    rawCircle.created_at = normalizeIsoTimestamp(rawCircle.created_at);
    const circle = circleFromRow(circleRowSchema.parse(rawCircle));

    const [roleRes, membersRes, apptsRes] = await Promise.all([
      fetchSignedInMemberRole(client, circle.id, userId),
      client.from('circle_members').select('*').eq('circle_id', circle.id),
      client.from('appointments').select('*').eq('circle_id', circle.id),
    ]);

    if (roleRes.error) throw new Error(roleRes.error.message);
    if (membersRes.error) throw new Error(membersRes.error.message);
    if (apptsRes.error) throw new Error(apptsRes.error.message);

    const parsedMembers = (Array.isArray(membersRes.data) ? membersRes.data : []).map((row) => {
      const normalized = { ...(row as Record<string, unknown>) };
      normalized.joined_at = normalizeIsoTimestamp(normalized.joined_at);
      return circleMemberRowSchema.parse(normalized);
    });

    const members: CalendarMemberOption[] = parsedMembers.map((m) => ({
      userId: m.user_id,
      role: m.role,
      displayName: `${en.circle.defaultMemberName} (${roleLabel(m.role)})`,
    }));

    const appointments = (Array.isArray(apptsRes.data) ? apptsRes.data : [])
      .map((row) => {
        const normalized = { ...(row as Record<string, unknown>) };
        normalized.starts_at = normalizeIsoTimestamp(normalized.starts_at);
        normalized.ends_at =
          normalized.ends_at === null || normalized.ends_at === undefined
            ? null
            : normalizeIsoTimestamp(normalized.ends_at);
        return appointmentFromRow(appointmentRowSchema.parse(normalized));
      })
      .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());

    await syncAllAppointmentReminders(appointments, {
      ...(deps.notificationAdapter ? { adapter: deps.notificationAdapter } : {}),
      now,
    });

    return {
      ok: true,
      circle,
      memberRole: roleRes.role,
      members,
      appointments,
      isOffline: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const offline = isNetworkFailureMessage(message);
    return {
      ok: false,
      errorCode: offline ? 'NETWORK_ERROR' : 'LOAD_CALENDAR_FAILED',
      isOffline: offline,
    };
  }
}

export async function addAppointment(
  input: AppointmentDraftInput & { memberRole?: MemberRole },
  deps: CalendarDeps = {},
): Promise<
  | { ok: true; appointment: Appointment }
  | { ok: false; errorCode: CalendarErrorCode; isOffline: boolean }
> {
  if (input.memberRole === 'viewer') {
    return { ok: false, errorCode: 'FORBIDDEN_ROLE', isOffline: false };
  }

  const validated = validateAppointmentDraft(input);
  if (!validated.ok) {
    return { ok: false, errorCode: validated.errorCode, isOffline: false };
  }

  if (deps.isOffline) {
    return { ok: false, errorCode: 'NETWORK_ERROR', isOffline: true };
  }

  const mocks = loadCareCircleMocks(deps.env);
  const nowFn = deps.now ?? (() => (mocks ? new Date(DEFAULT_MOCK_NOW_ISO) : new Date()));

  if (mocks) {
    const snapshot = getOrInitMockTodaySnapshot(mocks);
    const created: Appointment = {
      id: `c1400099-0000-4000-8000-${String(snapshot.appointments.length + 1).padStart(12, '0')}`,
      circleId: validated.payload.circleId,
      title: validated.payload.title,
      startsAt: validated.payload.startsAt,
      endsAt: validated.payload.endsAt,
      location: validated.payload.location,
      driverUserId: validated.payload.driverUserId,
      notes: validated.payload.notes,
    };
    snapshot.appointments.push(created);
    await syncAppointmentReminders(created, {
      ...(deps.notificationAdapter ? { adapter: deps.notificationAdapter } : {}),
      now: nowFn(),
    });
    await refreshTodayAfterSave(deps);
    return { ok: true, appointment: created };
  }

  const getClient = deps.getClient ?? getSupabaseClient;
  let appointment: Appointment;

  try {
    const client = getClient();
    const res = await client
      .from('appointments')
      .insert({
        circle_id: validated.payload.circleId,
        title: validated.payload.title,
        starts_at: validated.payload.startsAt,
        ends_at: validated.payload.endsAt,
        location: validated.payload.location,
        driver_user_id: validated.payload.driverUserId,
        notes: validated.payload.notes,
      })
      .select('*');

    if (res.error) {
      const offline = isNetworkFailureMessage(res.error.message, res.error.code);
      return {
        ok: false,
        errorCode: offline ? 'NETWORK_ERROR' : 'SAVE_APPOINTMENT_FAILED',
        isOffline: offline,
      };
    }

    const rows = Array.isArray(res.data) ? res.data : [];
    if (rows.length === 0) {
      return { ok: false, errorCode: 'SAVE_APPOINTMENT_FAILED', isOffline: false };
    }

    const raw = { ...(rows[0] as Record<string, unknown>) };
    raw.starts_at = normalizeIsoTimestamp(raw.starts_at);
    raw.ends_at =
      raw.ends_at === null || raw.ends_at === undefined ? null : normalizeIsoTimestamp(raw.ends_at);
    appointment = appointmentFromRow(appointmentRowSchema.parse(raw));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const offline = isNetworkFailureMessage(message);
    return {
      ok: false,
      errorCode: offline ? 'NETWORK_ERROR' : 'SAVE_APPOINTMENT_FAILED',
      isOffline: offline,
    };
  }

  await syncAppointmentReminders(appointment, {
    ...(deps.notificationAdapter ? { adapter: deps.notificationAdapter } : {}),
    now: nowFn(),
  });
  await refreshTodayAfterSave(deps);
  return { ok: true, appointment };
}

export async function updateAppointment(
  input: AppointmentDraftInput & {
    appointmentId: string;
    memberRole?: MemberRole;
  },
  deps: CalendarDeps = {},
): Promise<
  | { ok: true; appointment: Appointment }
  | { ok: false; errorCode: CalendarErrorCode; isOffline: boolean }
> {
  if (input.memberRole === 'viewer') {
    return { ok: false, errorCode: 'FORBIDDEN_ROLE', isOffline: false };
  }

  if (!input.appointmentId.trim()) {
    return { ok: false, errorCode: 'VALIDATION_ERROR', isOffline: false };
  }

  const validated = validateAppointmentDraft(input);
  if (!validated.ok) {
    return { ok: false, errorCode: validated.errorCode, isOffline: false };
  }

  if (deps.isOffline) {
    return { ok: false, errorCode: 'NETWORK_ERROR', isOffline: true };
  }

  const mocks = loadCareCircleMocks(deps.env);
  const nowFn = deps.now ?? (() => (mocks ? new Date(DEFAULT_MOCK_NOW_ISO) : new Date()));

  if (mocks) {
    const snapshot = getOrInitMockTodaySnapshot(mocks);
    const idx = snapshot.appointments.findIndex((a) => a.id === input.appointmentId.trim());
    if (idx < 0) {
      return { ok: false, errorCode: 'SAVE_APPOINTMENT_FAILED', isOffline: false };
    }
    const updated: Appointment = {
      ...snapshot.appointments[idx]!,
      title: validated.payload.title,
      startsAt: validated.payload.startsAt,
      endsAt: validated.payload.endsAt,
      location: validated.payload.location,
      driverUserId: validated.payload.driverUserId,
      notes: validated.payload.notes,
    };
    snapshot.appointments[idx] = updated;
    await syncAppointmentReminders(updated, {
      ...(deps.notificationAdapter ? { adapter: deps.notificationAdapter } : {}),
      now: nowFn(),
    });
    await refreshTodayAfterSave(deps);
    return { ok: true, appointment: updated };
  }

  const getClient = deps.getClient ?? getSupabaseClient;
  let appointment: Appointment;

  try {
    const client = getClient();
    const res = await client
      .from('appointments')
      .update({
        title: validated.payload.title,
        starts_at: validated.payload.startsAt,
        ends_at: validated.payload.endsAt,
        location: validated.payload.location,
        driver_user_id: validated.payload.driverUserId,
        notes: validated.payload.notes,
      })
      .eq('circle_id', validated.payload.circleId)
      .eq('id', input.appointmentId.trim())
      .select('*');

    if (res.error) {
      const offline = isNetworkFailureMessage(res.error.message, res.error.code);
      return {
        ok: false,
        errorCode: offline ? 'NETWORK_ERROR' : 'SAVE_APPOINTMENT_FAILED',
        isOffline: offline,
      };
    }

    const rows = Array.isArray(res.data) ? res.data : [];
    if (rows.length === 0) {
      return { ok: false, errorCode: 'SAVE_APPOINTMENT_FAILED', isOffline: false };
    }

    const raw = { ...(rows[0] as Record<string, unknown>) };
    raw.starts_at = normalizeIsoTimestamp(raw.starts_at);
    raw.ends_at =
      raw.ends_at === null || raw.ends_at === undefined ? null : normalizeIsoTimestamp(raw.ends_at);
    appointment = appointmentFromRow(appointmentRowSchema.parse(raw));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const offline = isNetworkFailureMessage(message);
    return {
      ok: false,
      errorCode: offline ? 'NETWORK_ERROR' : 'SAVE_APPOINTMENT_FAILED',
      isOffline: offline,
    };
  }

  await syncAppointmentReminders(appointment, {
    ...(deps.notificationAdapter ? { adapter: deps.notificationAdapter } : {}),
    now: nowFn(),
  });
  await refreshTodayAfterSave(deps);
  return { ok: true, appointment };
}

export async function deleteAppointment(
  input: {
    circleId: string;
    appointmentId: string;
    memberRole?: MemberRole;
  },
  deps: CalendarDeps = {},
): Promise<{ ok: true } | { ok: false; errorCode: CalendarErrorCode; isOffline: boolean }> {
  if (input.memberRole === 'viewer') {
    return { ok: false, errorCode: 'FORBIDDEN_ROLE', isOffline: false };
  }

  if (!input.circleId.trim() || !input.appointmentId.trim()) {
    return { ok: false, errorCode: 'VALIDATION_ERROR', isOffline: false };
  }

  if (deps.isOffline) {
    return { ok: false, errorCode: 'NETWORK_ERROR', isOffline: true };
  }

  const mocks = loadCareCircleMocks(deps.env);
  if (mocks) {
    const snapshot = getOrInitMockTodaySnapshot(mocks);
    const exists = snapshot.appointments.some((a) => a.id === input.appointmentId.trim());
    if (!exists) {
      return { ok: false, errorCode: 'SAVE_APPOINTMENT_FAILED', isOffline: false };
    }
    snapshot.appointments = snapshot.appointments.filter(
      (a) => a.id !== input.appointmentId.trim(),
    );
    await cancelAppointmentReminders(input.appointmentId.trim(), deps.notificationAdapter);
    await refreshTodayAfterSave(deps);
    return { ok: true };
  }

  const getClient = deps.getClient ?? getSupabaseClient;

  try {
    const client = getClient();
    const res = await client
      .from('appointments')
      .delete()
      .eq('circle_id', input.circleId.trim())
      .eq('id', input.appointmentId.trim());

    if (res.error) {
      const offline = isNetworkFailureMessage(res.error.message, res.error.code);
      return {
        ok: false,
        errorCode: offline ? 'NETWORK_ERROR' : 'SAVE_APPOINTMENT_FAILED',
        isOffline: offline,
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const offline = isNetworkFailureMessage(message);
    return {
      ok: false,
      errorCode: offline ? 'NETWORK_ERROR' : 'SAVE_APPOINTMENT_FAILED',
      isOffline: offline,
    };
  }

  await cancelAppointmentReminders(input.appointmentId.trim(), deps.notificationAdapter);
  await refreshTodayAfterSave(deps);
  return { ok: true };
}

export function extractLocalAppointmentFormFields(
  appointment: Appointment,
  timezone: string,
): {
  title: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  location: string;
  notes: string;
  driverUserId: string | null;
} {
  return {
    title: appointment.title,
    startDate: formatLocalDateInZone(appointment.startsAt, timezone),
    startTime: formatLocalTimeInZone(appointment.startsAt, timezone),
    endDate: appointment.endsAt ? formatLocalDateInZone(appointment.endsAt, timezone) : '',
    endTime: appointment.endsAt ? formatLocalTimeInZone(appointment.endsAt, timezone) : '',
    location: appointment.location ?? '',
    notes: appointment.notes ?? '',
    driverUserId: appointment.driverUserId ?? null,
  };
}
