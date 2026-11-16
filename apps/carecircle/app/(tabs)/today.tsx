import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { loadCareCircleMocks } from '../../src/features/mocks';
import {
  DEFAULT_MOCK_NOW_ISO,
  checkOffDose,
  flushQueuedDoseCheckOffs,
  getOrInitMockTodaySnapshot,
  loadTodaySnapshot,
  selectTodayAgenda,
  type TodayDeps,
  type TodayDoseStatusAction,
  type TodaySnapshot,
} from '../../src/features/today/api';
import { TodayScreenView, type TodayNotice } from '../../src/features/today/components';
import {
  subscribeToCircleDoseEvents,
  type RealtimeSupabaseClientLike,
} from '../../src/features/today/realtime';
import { onTodayReloadRequested } from '../../src/features/today/refresh';

const EMPTY_CIRCLE_ID = '00000000-0000-4000-8000-000000000000';

/** While offline or with check-offs waiting, try again this often. */
export const TODAY_RETRY_INTERVAL_MS = 30_000;

export interface TodayRouteProps {
  deps?: TodayDeps;
  referenceNow?: Date;
}

export default function TodayScreen({ deps, referenceNow }: TodayRouteProps = {}) {
  const mocks = loadCareCircleMocks(deps?.env);
  const hasBackend =
    Boolean(mocks) ||
    Boolean(deps?.getClient) ||
    Boolean(deps?.isOffline) ||
    Boolean(process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim());

  const [snapshot, setSnapshot] = useState<TodaySnapshot | null>(() =>
    mocks ? getOrInitMockTodaySnapshot(mocks) : null,
  );
  const [isLoading, setIsLoading] = useState<boolean>(() => Boolean(!mocks && hasBackend));
  const [hasError, setHasError] = useState<boolean>(false);
  const [isOffline, setIsOffline] = useState<boolean>(() => Boolean(deps?.isOffline));
  const [queuedCount, setQueuedCount] = useState<number>(0);
  const [notice, setNotice] = useState<TodayNotice | null>(null);
  const [reloadToken, setReloadToken] = useState<number>(0);
  const snapshotRef = useRef<TodaySnapshot | null>(snapshot);
  snapshotRef.current = snapshot;

  const effectiveNow = useMemo(() => {
    if (referenceNow) return referenceNow;
    if (deps?.now) return deps.now();
    if (mocks) return new Date(DEFAULT_MOCK_NOW_ISO);
    return new Date();
  }, [deps, mocks, referenceNow, reloadToken]);

  useEffect(() => {
    if (!hasBackend) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      if (!mocks && !snapshotRef.current) {
        setIsLoading(true);
      }
      setHasError(false);

      if (!deps?.isOffline) {
        const flushed = await flushQueuedDoseCheckOffs(deps);
        if (!cancelled && flushed.refusedCount > 0) {
          setNotice('refused');
        }
      }

      const res = await loadTodaySnapshot(deps);
      if (cancelled) return;

      setIsLoading(false);
      if (res.ok) {
        setSnapshot(res.snapshot);
        setIsOffline(res.isOffline);
        setQueuedCount(res.queuedCount);
        setHasError(false);
      } else {
        setIsOffline(res.isOffline);
        setHasError(!res.isOffline);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [deps, hasBackend, mocks, reloadToken]);

  const handleRetry = useCallback(() => {
    setReloadToken((n) => n + 1);
  }, []);

  // A medicine was added, edited or paused on the Meds screen: the doses may have changed.
  useEffect(() => onTodayReloadRequested(handleRetry), [handleRetry]);

  const circleId = snapshot?.circle.id ?? null;
  const snapshotUserId = snapshot?.userId;

  // Live Realtime updates for the circle's dose_events (another carer checking off a dose, or
  // mark-missed transitioning an overdue pending dose to missed).
  useEffect(() => {
    if (!hasBackend || mocks || deps?.isOffline || !circleId || circleId === EMPTY_CIRCLE_ID) {
      return;
    }
    if (deps?.getClient) {
      const candidate = deps.getClient() as unknown as Partial<RealtimeSupabaseClientLike>;
      if (typeof candidate?.channel !== 'function') {
        return;
      }
    }
    return subscribeToCircleDoseEvents({
      circleId,
      ...(deps?.getClient
        ? {
            getClient: () => deps.getClient!() as unknown as RealtimeSupabaseClientLike,
          }
        : {}),
      ...(deps?.storage ? { storage: deps.storage } : {}),
      userId: snapshotUserId,
      onDoseEventChange: (updatedDose) => {
        setSnapshot((prev) => {
          if (!prev || prev.circle.id !== circleId) return prev;
          const exists = prev.doseEvents.some((d) => d.id === updatedDose.id);
          return {
            ...prev,
            doseEvents: exists
              ? prev.doseEvents.map((d) => (d.id === updatedDose.id ? updatedDose : d))
              : [...prev.doseEvents, updatedDose],
          };
        });
      },
    });
  }, [circleId, deps, hasBackend, mocks, snapshotUserId]);

  // "Sent when the network returns": the app has no network listener, so try again when the app
  // comes back to the foreground, and every 30 seconds while offline or while check-offs wait.
  useEffect(() => {
    if (!hasBackend || mocks) return;
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') handleRetry();
    });
    return () => sub.remove();
  }, [handleRetry, hasBackend, mocks]);

  useEffect(() => {
    if (!hasBackend || mocks || deps?.isOffline) return;
    if (!isOffline && queuedCount === 0) return;
    const timer = setInterval(handleRetry, TODAY_RETRY_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [deps?.isOffline, handleRetry, hasBackend, isOffline, mocks, queuedCount]);

  const handleCheckOffDose = useCallback(
    (doseEventId: string, status: TodayDoseStatusAction) => {
      const actedAt = (deps?.now ? deps.now() : mocks ? effectiveNow : new Date()).toISOString();
      const before = snapshotRef.current?.doseEvents.find((dose) => dose.id === doseEventId);
      setNotice(null);
      setSnapshot((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          doseEvents: prev.doseEvents.map((dose) =>
            dose.id === doseEventId ? { ...dose, status, actedAt } : dose,
          ),
        };
      });

      void (async () => {
        const res = await checkOffDose(
          {
            doseEventId,
            status,
            memberRole: snapshotRef.current?.memberRole,
          },
          deps,
        );
        if (res.ok) {
          setQueuedCount(res.queuedCount);
          if (res.queued) {
            setIsOffline(true);
          }
          return;
        }
        // The server did not record it. Never leave "Given" on screen for a dose nobody saved:
        // put the dose back as it was, say so, and reload what the server has.
        setSnapshot((prev) => {
          if (!prev || !before) return prev;
          return {
            ...prev,
            doseEvents: prev.doseEvents.map((dose) => (dose.id === doseEventId ? before : dose)),
          };
        });
        setNotice('checkOffFailed');
        if (res.errorCode === 'CHECKOFF_FAILED') {
          handleRetry();
        }
      })();
    },
    [deps, effectiveNow, handleRetry, mocks],
  );

  const agenda = useMemo(
    () => (snapshot ? selectTodayAgenda(snapshot, effectiveNow) : null),
    [effectiveNow, snapshot],
  );

  const circleTitle = useMemo(() => {
    if (!snapshot?.circle.careRecipientName) {
      return undefined;
    }
    return `${snapshot.circle.name} · ${snapshot.circle.careRecipientName}`;
  }, [snapshot]);

  return (
    <TodayScreenView
      circleTitle={circleTitle}
      agenda={agenda}
      isLoading={isLoading}
      hasError={hasError}
      isOffline={isOffline}
      queuedCount={queuedCount}
      notice={notice}
      onRetry={handleRetry}
      onCheckOffDose={handleCheckOffDose}
    />
  );
}
