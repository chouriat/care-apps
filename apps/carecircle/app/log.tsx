import type { LogType } from '@carecircle/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import en from '../i18n/en.json';
import {
  CARE_LOG_PAGE_SIZE,
  CareLogScreenView,
  defaultTrackPaywallViewed,
  exportCareLogPdf,
  fetchCareLogPage,
  loadCareLogContext,
  type CareLogDeps,
  type CareLogEntryItem,
  type CareLogMemberOption,
} from '../src/features/log';
import { PaywallSheet } from '../src/features/paywall/components';

export interface CareLogRouteProps {
  deps?: CareLogDeps;
}

export default function CareLogRoute({ deps }: CareLogRouteProps = {}) {
  const depsRef = useRef<CareLogDeps | undefined>(deps);
  depsRef.current = deps;

  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [circleId, setCircleId] = useState('');
  const [circleName, setCircleName] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [isFamilyPlan, setIsFamilyPlan] = useState(false);
  const [members, setMembers] = useState<CareLogMemberOption[]>([]);
  const [entries, setEntries] = useState<CareLogEntryItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [selectedType, setSelectedType] = useState<LogType | null>(null);
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [exportFrom, setExportFrom] = useState('');
  const [exportTo, setExportTo] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [paywallVisible, setPaywallVisible] = useState(false);
  const exportingRef = useRef(false);

  const memberDisplayMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) {
      map.set(m.userId, m.displayName);
    }
    return map;
  }, [members]);

  const loadInitial = useCallback(async () => {
    const activeDeps = depsRef.current;
    setIsLoading(true);
    setHasError(false);
    const ctx = await loadCareLogContext(activeDeps);
    if (!ctx.ok) {
      setHasError(true);
      setIsLoading(false);
      return;
    }

    setCircleId(ctx.circleId);
    setCircleName(ctx.circleName);
    setTimezone(ctx.timezone);
    setIsFamilyPlan(ctx.isFamilyPlan);
    setMembers(ctx.members);
    setExportFrom((prev) => prev || ctx.defaultFrom);
    setExportTo((prev) => prev || ctx.defaultTo);

    const displayMap = new Map<string, string>();
    for (const m of ctx.members) {
      displayMap.set(m.userId, m.displayName);
    }

    const page = await fetchCareLogPage(
      {
        circleId: ctx.circleId,
        offset: 0,
        limit: CARE_LOG_PAGE_SIZE,
        typeFilter: selectedType,
        personFilter: selectedPersonId,
        memberDisplayNames: displayMap,
      },
      activeDeps,
    );

    if (!page.ok) {
      setHasError(true);
      setIsLoading(false);
      return;
    }

    setEntries(page.entries);
    setHasMore(page.hasMore);
    setIsLoading(false);
  }, [selectedPersonId, selectedType]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  const handleLoadMore = useCallback(async () => {
    if (!circleId || isLoadingMore || !hasMore) return;
    setIsLoadingMore(true);
    const page = await fetchCareLogPage(
      {
        circleId,
        offset: entries.length,
        limit: CARE_LOG_PAGE_SIZE,
        typeFilter: selectedType,
        personFilter: selectedPersonId,
        memberDisplayNames: memberDisplayMap,
      },
      depsRef.current,
    );
    if (page.ok) {
      setEntries((prev) => [...prev, ...page.entries]);
      setHasMore(page.hasMore);
    } else {
      setHasError(true);
    }
    setIsLoadingMore(false);
  }, [
    circleId,
    entries.length,
    hasMore,
    isLoadingMore,
    memberDisplayMap,
    selectedPersonId,
    selectedType,
  ]);

  const openPaywall = useCallback(() => {
    const trackPaywall = depsRef.current?.trackPaywallViewed ?? defaultTrackPaywallViewed;
    try {
      trackPaywall();
    } catch {
      // Analytics never blocks UI.
    }
    setPaywallVisible(true);
  }, []);

  const handlePressExportPdf = useCallback(async () => {
    if (!circleId || exportingRef.current) return;
    setExportError(null);

    if (!isFamilyPlan) {
      openPaywall();
      return;
    }

    exportingRef.current = true;
    setIsExporting(true);
    try {
      const res = await exportCareLogPdf(
        {
          circleId,
          from: exportFrom,
          to: exportTo,
        },
        depsRef.current,
      );

      if (!res.ok) {
        if (res.errorCode === 'QUOTA_EXCEEDED') {
          openPaywall();
        } else if (res.errorCode === 'RANGE_INVALID') {
          setExportError(en.careLog.exportRangeInvalidMessage);
        } else {
          setExportError(en.careLog.exportErrorMessage);
        }
      }
    } finally {
      exportingRef.current = false;
      setIsExporting(false);
    }
  }, [circleId, exportFrom, exportTo, isFamilyPlan, openPaywall]);

  return (
    <View style={{ flex: 1 }}>
      <CareLogScreenView
        circleName={circleName}
        timezone={timezone}
        members={members}
        entries={entries}
        selectedType={selectedType}
        selectedPersonId={selectedPersonId}
        onSelectType={(nextType) => setSelectedType(nextType)}
        onSelectPerson={(nextPersonId) => setSelectedPersonId(nextPersonId)}
        hasMore={hasMore}
        isLoading={isLoading}
        isLoadingMore={isLoadingMore}
        hasError={hasError}
        onRetry={() => {
          void loadInitial();
        }}
        onLoadMore={() => {
          void handleLoadMore();
        }}
        exportFrom={exportFrom}
        exportTo={exportTo}
        onChangeExportFrom={setExportFrom}
        onChangeExportTo={setExportTo}
        onPressExportPdf={() => {
          void handlePressExportPdf();
        }}
        isExporting={isExporting}
        exportError={exportError}
      />
      <PaywallSheet visible={paywallVisible} onClose={() => setPaywallVisible(false)} />
    </View>
  );
}
