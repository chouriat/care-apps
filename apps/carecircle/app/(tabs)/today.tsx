import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { TodayScreenView } from '../../src/features/today/components';

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
  const [reloadToken, setReloadToken] = useState<number>(0);

  const effectiveNow = useMemo(() => {
    if (referenceNow) return referenceNow;
    if (deps?.now) return deps.now();
    if (mocks) return new Date(DEFAULT_MOCK_NOW_ISO);
    return new Date();
  }, [deps, mocks, referenceNow]);

  useEffect(() => {
    if (!hasBackend) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      if (!mocks && !snapshot) {
        setIsLoading(true);
      }
      setHasError(false);

      if (!deps?.isOffline) {
        await flushQueuedDoseCheckOffs(deps);
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

  const handleCheckOffDose = useCallback(
    (doseEventId: string, status: TodayDoseStatusAction) => {
      const actedAt = effectiveNow.toISOString();
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
            memberRole: snapshot?.memberRole,
          },
          deps,
        );
        if (res.ok) {
          setQueuedCount(res.queuedCount);
          if (res.queued) {
            setIsOffline(true);
          }
        }
      })();
    },
    [deps, effectiveNow, snapshot?.memberRole],
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
      onRetry={handleRetry}
      onCheckOffDose={handleCheckOffDose}
    />
  );
}
