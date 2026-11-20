import type { Appointment, MemberRole } from '@carecircle/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  addAppointment,
  deleteAppointment,
  loadCalendarScreen,
  subscribeToCircleAppointments,
  updateAppointment,
  type AppointmentFormDraft,
  type CalendarDeps,
  type CalendarMemberOption,
  CalendarScreenView,
} from '../../src/features/calendar';
import { loadCareCircleMocks } from '../../src/features/mocks';
import { DEFAULT_MOCK_NOW_ISO, formatLocalDateInZone } from '../../src/features/today/api';
import type { RealtimeSupabaseClientLike } from '../../src/features/today/realtime';

const EMPTY_CIRCLE_ID = '00000000-0000-4000-8000-000000000000';

export interface CalendarRouteProps {
  deps?: CalendarDeps;
  referenceNow?: Date;
}

export default function CalendarScreen({ deps, referenceNow }: CalendarRouteProps = {}) {
  const mocks = loadCareCircleMocks(deps?.env);
  const effectiveNow = useMemo(() => {
    if (referenceNow) return referenceNow;
    if (deps?.now) return deps.now();
    if (mocks) return new Date(DEFAULT_MOCK_NOW_ISO);
    return new Date();
  }, [deps, mocks, referenceNow]);

  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [isOffline, setIsOffline] = useState(Boolean(deps?.isOffline));
  const [notSavedNotice, setNotSavedNotice] = useState(false);
  const [circleId, setCircleId] = useState('');
  const [circleTitle, setCircleTitle] = useState<string | undefined>(undefined);
  const [circleTimezone, setCircleTimezone] = useState('UTC');
  const [memberRole, setMemberRole] = useState<MemberRole>('viewer');
  const [members, setMembers] = useState<CalendarMemberOption[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);

  const reload = useCallback(async () => {
    setIsLoading(true);
    setHasError(false);
    const res = await loadCalendarScreen(deps);
    if (res.ok) {
      setCircleId(res.circle.id);
      setCircleTitle(
        res.circle.careRecipientName
          ? `${res.circle.name} · ${res.circle.careRecipientName}`
          : res.circle.name,
      );
      setCircleTimezone(res.circle.timezone);
      setMemberRole(res.memberRole);
      setMembers(res.members);
      setAppointments(res.appointments);
      setIsOffline(res.isOffline);
      setHasError(false);
    } else {
      setIsOffline(res.isOffline);
      setHasError(!res.isOffline);
    }
    setIsLoading(false);
  }, [deps]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // After a confirmed save or delete: reload without the full-screen spinner, and never turn a
  // confirmed save into "Not saved" if only the reload fails.
  const refreshList = useCallback(async () => {
    const res = await loadCalendarScreen(deps);
    if (res.ok) {
      setAppointments(res.appointments);
      setMembers(res.members);
      setMemberRole(res.memberRole);
      setIsOffline(res.isOffline);
      setHasError(false);
    } else {
      setIsOffline(res.isOffline);
      setHasError(!res.isOffline);
    }
  }, [deps]);

  // Live Realtime updates for the circle's appointments
  useEffect(() => {
    if (!circleId || circleId === EMPTY_CIRCLE_ID || mocks || deps?.isOffline) {
      return;
    }
    if (deps?.getClient) {
      const candidate = deps.getClient() as unknown as Partial<RealtimeSupabaseClientLike>;
      if (typeof candidate?.channel !== 'function') {
        return;
      }
    }
    return subscribeToCircleAppointments({
      circleId,
      ...(deps?.getClient
        ? {
            getClient: () => deps.getClient!() as unknown as RealtimeSupabaseClientLike,
          }
        : {}),
      ...(deps?.notificationAdapter ? { notificationAdapter: deps.notificationAdapter } : {}),
      ...(deps?.now ? { now: deps.now } : {}),
      onAppointmentUpsert: (updated) => {
        setAppointments((prev) => {
          const exists = prev.some((a) => a.id === updated.id);
          const next = exists
            ? prev.map((a) => (a.id === updated.id ? updated : a))
            : [...prev, updated];
          return next.sort(
            (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
          );
        });
      },
      onAppointmentDelete: (deletedId) => {
        setAppointments((prev) => prev.filter((a) => a.id !== deletedId));
      },
    });
  }, [circleId, deps, mocks]);

  const handleSaveAppointment = useCallback(
    async (draft: AppointmentFormDraft, editingAppointmentId: string | null): Promise<boolean> => {
      if (!circleId) return false;
      setNotSavedNotice(false);

      const res = editingAppointmentId
        ? await updateAppointment(
            {
              circleId,
              appointmentId: editingAppointmentId,
              timezone: circleTimezone,
              ...draft,
              memberRole,
            },
            deps,
          )
        : await addAppointment(
            {
              circleId,
              timezone: circleTimezone,
              ...draft,
              memberRole,
            },
            deps,
          );

      if (!res.ok) {
        setIsOffline(res.isOffline);
        setNotSavedNotice(true);
        return false;
      }

      await refreshList();
      return true;
    },
    [circleId, circleTimezone, deps, memberRole, refreshList],
  );

  const handleDeleteAppointment = useCallback(
    async (appointmentId: string): Promise<boolean> => {
      if (!circleId) return false;
      setNotSavedNotice(false);

      const res = await deleteAppointment(
        {
          circleId,
          appointmentId,
          memberRole,
        },
        deps,
      );

      if (!res.ok) {
        setIsOffline(res.isOffline);
        setNotSavedNotice(true);
        return false;
      }

      await refreshList();
      return true;
    },
    [circleId, deps, memberRole, refreshList],
  );

  const initialSelectedDate = useMemo(
    () => formatLocalDateInZone(effectiveNow, circleTimezone),
    [circleTimezone, effectiveNow],
  );

  return (
    <CalendarScreenView
      circleId={circleId}
      circleTitle={circleTitle}
      circleTimezone={circleTimezone}
      memberRole={memberRole}
      members={members}
      appointments={appointments}
      initialSelectedDate={initialSelectedDate}
      isLoading={isLoading}
      hasError={hasError}
      isOffline={isOffline}
      notSavedNotice={notSavedNotice}
      onRetry={() => {
        void reload();
      }}
      onSaveAppointment={handleSaveAppointment}
      onDeleteAppointment={handleDeleteAppointment}
    />
  );
}
