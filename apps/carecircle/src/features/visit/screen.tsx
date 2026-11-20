import type { AiErrorCode, SummarizeVisitOutput } from '@carecircle/ai-gateway';
import type { Circle, Medication, MemberRole } from '@carecircle/core';
import {
  Button,
  Card,
  Chip,
  ConfirmDraft,
  EmptyState,
  ErrorState,
  Header,
  MIN_TOUCH_TARGET_PT,
  useTheme,
  type DraftField,
} from '@carecircle/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import en from '../../../i18n/en.json';
import { addMedication, pauseMedication, updateMedication, type MedsErrorCode } from '../meds/api';
import {
  MedicationFormCard,
  draftFromMedication,
  type ValidatedMedicationFormPayload,
} from '../meds/components';
import { requestMedsReload } from '../meds/refresh';
import { PaywallSheet } from '../paywall/components';
import { requestTodayReload } from '../today/refresh';
import {
  defaultTrackVisitNoteSaved,
  loadVisitNoteContext,
  resolveLocalMidnightInTimezoneToUtc,
  saveFollowUpTask,
  saveVisitNoteRow,
  summarizeVisit,
  type SummarizeVisitApiDeps,
} from './api';
import {
  VisitAudioPermissionError,
  startVisitAudioRecording,
  type CapturedVisitRecording,
  type CreateVisitAudioRecorderOptions,
  type VisitAudioRecorderSession,
} from './recorder';
import { MAX_VISIT_RECORDING_MS } from './storage';

export type ItemDecision = 'accepted' | 'rejected' | null;

export interface FollowUpDraftItem {
  title: string;
  dueHint: string | null;
  dueDate: string;
  decision: ItemDecision;
}

export type MedChangeDraftItem = SummarizeVisitOutput['medChanges'][number] & {
  decision: ItemDecision;
};

export type VisitErrorCode = AiErrorCode | 'AUDIO_PERMISSION_DENIED' | 'RECORDING_FAILED';

export interface VisitScreenDeps extends SummarizeVisitApiDeps {
  startRecording?: (
    options?: CreateVisitAudioRecorderOptions,
  ) => Promise<VisitAudioRecorderSession>;
  saveVisitNote?: typeof saveVisitNoteRow;
  saveFollowUp?: typeof saveFollowUpTask;
  pauseMed?: typeof pauseMedication;
  updateMed?: typeof updateMedication;
  addMed?: typeof addMedication;
}

export interface VisitNoteScreenProps {
  appointmentId?: string | null;
  circleId?: string;
  circleTimezone?: string;
  memberRole?: MemberRole;
  initialMedications?: Medication[];
  deps?: VisitScreenDeps;
  onNavigateSignIn?: () => void;
  onViewerRedirect?: () => void;
  onSaved?: () => void;
}

function formatDurationMmSs(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function VisitNoteScreen({
  appointmentId = null,
  circleId: initialCircleId,
  circleTimezone: initialTimezone,
  memberRole: initialMemberRole,
  initialMedications,
  deps,
  onNavigateSignIn,
  onViewerRedirect,
  onSaved,
}: VisitNoteScreenProps) {
  const { colors, radii, spacing, typography } = useTheme();
  const hasInitialContext = initialCircleId !== undefined && initialMemberRole !== undefined;

  const [contextStatus, setContextStatus] = useState<
    'loading' | 'ok' | 'no_circle' | 'offline' | 'error'
  >(deps?.isOffline ? 'offline' : hasInitialContext ? 'ok' : 'loading');
  const [isOfflineNotice, setIsOfflineNotice] = useState<boolean>(Boolean(deps?.isOffline));
  const [contextReloadKey, setContextReloadKey] = useState(0);
  const [circle, setCircle] = useState<Circle | null>(
    hasInitialContext
      ? {
          id: initialCircleId,
          name: 'CareCircle',
          careRecipientName: '',
          careRecipientDob: null,
          timezone: initialTimezone ?? 'UTC',
          createdBy: null,
          createdAt: '2026-11-15T12:00:00.000Z',
        }
      : null,
  );
  const [memberRole, setMemberRole] = useState<MemberRole>(initialMemberRole ?? 'viewer');
  const [activeMedications, setActiveMedications] = useState<Medication[]>(
    initialMedications ?? [],
  );

  // Recording & typing state
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [capturedRecording, setCapturedRecording] = useState<CapturedVisitRecording | null>(null);
  const [autoStoppedNotice, setAutoStoppedNotice] = useState(false);
  const [typedText, setTypedText] = useState('');
  const [lastSubmittedTranscript, setLastSubmittedTranscript] = useState<string | null>(null);
  const recorderSessionRef = useRef<VisitAudioRecorderSession | null>(null);
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Summarise & draft state
  const [isSummarising, setIsSummarising] = useState(false);
  const [errorCode, setErrorCode] = useState<VisitErrorCode | null>(null);
  const [paywallVisible, setPaywallVisible] = useState(false);
  const [draft, setDraft] = useState<SummarizeVisitOutput | null>(null);
  const [summaryText, setSummaryText] = useState('');
  const [followUps, setFollowUps] = useState<FollowUpDraftItem[]>([]);
  const [medChanges, setMedChanges] = useState<MedChangeDraftItem[]>([]);
  const [questionsToAsk, setQuestionsToAsk] = useState<string[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Save state & partial failure tracking
  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef(false);
  const visitNoteSavedRef = useRef(false);
  const savedFollowUpIndicesRef = useRef<Set<number>>(new Set());
  const savedStopIndicesRef = useRef<Set<number>>(new Set());
  const analyticsSentRef = useRef(false);
  const [notSavedNotice, setNotSavedNotice] = useState(false);
  const [partialSaveState, setPartialSaveState] = useState<{
    savedParts: string[];
    unsavedParts: string[];
  } | null>(null);

  // Queued medication forms for accepted `change_dose` and `start` items
  const [pendingMedForms, setPendingMedForms] = useState<MedChangeDraftItem[]>([]);
  const [medFormSaveFailed, setMedFormSaveFailed] = useState(false);

  useEffect(() => {
    if (deps?.isOffline) {
      setIsOfflineNotice(true);
      if (!hasInitialContext) {
        setContextStatus('offline');
        return;
      }
    }
    if (hasInitialContext) {
      setCircle({
        id: initialCircleId,
        name: 'CareCircle',
        careRecipientName: '',
        careRecipientDob: null,
        timezone: initialTimezone ?? 'UTC',
        createdBy: null,
        createdAt: '2026-11-15T12:00:00.000Z',
      });
      setMemberRole(initialMemberRole);
      if (initialMedications !== undefined) {
        setActiveMedications(initialMedications);
      }
      setContextStatus('ok');
      return;
    }

    let cancelled = false;
    setContextStatus('loading');
    void (async () => {
      const ctx = await loadVisitNoteContext(deps);
      if (cancelled) return;
      setCircle(ctx.circle);
      setMemberRole(ctx.memberRole);
      setActiveMedications(ctx.activeMedications);
      setContextStatus(ctx.status);
      setIsOfflineNotice(ctx.status === 'offline');
    })();

    return () => {
      cancelled = true;
    };
  }, [
    contextReloadKey,
    deps,
    hasInitialContext,
    initialCircleId,
    initialMedications,
    initialMemberRole,
    initialTimezone,
  ]);

  useEffect(
    () => () => {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
    },
    [],
  );

  const canEdit = contextStatus === 'ok' && (memberRole === 'owner' || memberRole === 'helper');

  const clearTimer = useCallback(() => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
  }, []);

  const handleStartRecording = useCallback(async () => {
    if (!canEdit || isRecording || isSummarising) return;
    setErrorCode(null);
    setAutoStoppedNotice(false);
    setCapturedRecording(null);
    setElapsedMs(0);

    const startFn = deps?.startRecording ?? startVisitAudioRecording;
    try {
      const session = await startFn({
        maxDurationMs: MAX_VISIT_RECORDING_MS,
        onAutoStop: (rec) => {
          clearTimer();
          recorderSessionRef.current = null;
          setIsRecording(false);
          setElapsedMs(rec.durationMs);
          setCapturedRecording(rec);
          setAutoStoppedNotice(true);
        },
      });
      recorderSessionRef.current = session;
      setIsRecording(true);
      timerIntervalRef.current = setInterval(() => {
        setElapsedMs((prev) => Math.min(prev + 1000, MAX_VISIT_RECORDING_MS));
      }, 1000);
    } catch (err) {
      clearTimer();
      setIsRecording(false);
      if (
        err instanceof VisitAudioPermissionError ||
        (err instanceof Error && err.message === 'AUDIO_PERMISSION_DENIED')
      ) {
        setErrorCode('AUDIO_PERMISSION_DENIED');
      } else {
        setErrorCode('RECORDING_FAILED');
      }
    }
  }, [canEdit, clearTimer, deps?.startRecording, isRecording, isSummarising]);

  const handleStopRecording = useCallback(async () => {
    const session = recorderSessionRef.current;
    if (!session) return;
    clearTimer();
    recorderSessionRef.current = null;
    setIsRecording(false);
    try {
      const rec = await session.stop();
      setElapsedMs(rec.durationMs);
      setCapturedRecording(rec);
    } catch {
      setErrorCode('RECORDING_FAILED');
    }
  }, [clearTimer]);

  const applyDraft = useCallback((output: SummarizeVisitOutput) => {
    setDraft(output);
    setSummaryText(output.summary);
    setFollowUps(
      output.followUps.map((f) => ({
        title: f.title,
        dueHint: f.dueHint,
        dueDate: f.dueDate ?? '',
        decision: null,
      })),
    );
    setMedChanges(
      output.medChanges.map((m) => ({
        ...m,
        decision: null,
      })),
    );
    setQuestionsToAsk(output.questionsToAsk);
    setValidationError(null);
    setNotSavedNotice(false);
    setPartialSaveState(null);
    setPendingMedForms([]);
    visitNoteSavedRef.current = false;
    savedFollowUpIndicesRef.current = new Set();
    savedStopIndicesRef.current = new Set();
    analyticsSentRef.current = false;
  }, []);

  const handleSummarise = useCallback(async () => {
    if (!canEdit || !circle || isRecording || isSummarising) return;
    const trimmedNotes = typedText.trim();
    if (!capturedRecording && !trimmedNotes) return;

    setIsSummarising(true);
    setErrorCode(null);
    setValidationError(null);
    setNotSavedNotice(false);
    setPartialSaveState(null);

    const knownMeds = activeMedications.map((m) => ({
      id: m.id,
      name: m.name,
      strength: m.strength,
    }));

    const callInput = capturedRecording
      ? {
          circleId: circle.id,
          audioBytes: capturedRecording.bytes,
          contentType: capturedRecording.contentType,
          localUri: capturedRecording.uri,
          ...(trimmedNotes ? { text: trimmedNotes } : {}),
          knownMeds,
        }
      : {
          circleId: circle.id,
          text: trimmedNotes,
          knownMeds,
        };

    const res = await summarizeVisit(callInput, deps);
    setIsSummarising(false);

    if (!res.ok) {
      if (res.error.code === 'UNAUTHENTICATED') {
        onNavigateSignIn?.();
        return;
      }
      if (res.error.code === 'QUOTA_EXCEEDED') {
        setPaywallVisible(true);
      }
      setErrorCode(res.error.code);
      return;
    }

    setLastSubmittedTranscript(trimmedNotes || null);
    applyDraft(res.output);
  }, [
    activeMedications,
    applyDraft,
    canEdit,
    capturedRecording,
    circle,
    deps,
    isRecording,
    isSummarising,
    onNavigateSignIn,
    typedText,
  ]);

  const allItemsDecided = useMemo(() => {
    if (!draft) return false;
    const allFollowUpsDecided = followUps.every(
      (f) => f.decision === 'accepted' || f.decision === 'rejected',
    );
    const allMedsDecided = medChanges.every(
      (m) => m.decision === 'accepted' || m.decision === 'rejected',
    );
    return allFollowUpsDecided && allMedsDecided;
  }, [draft, followUps, medChanges]);

  const handleSave = useCallback(async () => {
    if (!draft || !circle || !allItemsDecided || savingRef.current) return;

    const trimmedSummary = summaryText.trim();
    if (!trimmedSummary) {
      setValidationError(en.visit.invalidSummaryMessage);
      return;
    }

    for (let i = 0; i < followUps.length; i += 1) {
      const f = followUps[i]!;
      if (f.decision !== 'accepted') continue;
      if (!f.title.trim()) {
        setValidationError(en.visit.invalidDueDateMessage);
        return;
      }
      if (f.dueDate.trim().length > 0) {
        try {
          resolveLocalMidnightInTimezoneToUtc(f.dueDate.trim(), circle.timezone);
        } catch {
          setValidationError(en.visit.invalidDueDateMessage);
          return;
        }
      }
    }

    setValidationError(null);
    setNotSavedNotice(false);
    setPartialSaveState(null);
    savingRef.current = true;
    setIsSaving(true);

    const saveNoteFn = deps?.saveVisitNote ?? saveVisitNoteRow;
    const saveTaskFn = deps?.saveFollowUp ?? saveFollowUpTask;
    const pauseMedFn = deps?.pauseMed ?? pauseMedication;
    const trackFn = deps?.trackVisitNoteSaved ?? defaultTrackVisitNoteSaved;

    const savedParts: string[] = [];
    const unsavedParts: string[] = [];
    let anyMedPaused = false;

    try {
      // 1. Save visit_notes row
      if (!visitNoteSavedRef.current) {
        const noteRes = await saveNoteFn(
          {
            circleId: circle.id,
            appointmentId,
            transcript: lastSubmittedTranscript,
            summary: trimmedSummary,
            memberRole,
          },
          deps,
        );
        if (noteRes.ok) {
          visitNoteSavedRef.current = true;
          savedParts.push(en.visit.partVisitNote);
        } else {
          unsavedParts.push(en.visit.partVisitNote);
        }
      } else {
        savedParts.push(en.visit.partVisitNote);
      }

      // 2. Save accepted follow-up tasks
      for (let i = 0; i < followUps.length; i += 1) {
        const f = followUps[i]!;
        if (f.decision !== 'accepted') continue;
        const partLabel = en.visit.partFollowUp.replace('{title}', f.title.trim());
        if (savedFollowUpIndicesRef.current.has(i)) {
          savedParts.push(partLabel);
          continue;
        }
        const taskRes = await saveTaskFn(
          {
            circleId: circle.id,
            title: f.title.trim(),
            dueDate: f.dueDate.trim() || null,
            timezone: circle.timezone,
            memberRole,
          },
          deps,
        );
        if (taskRes.ok) {
          savedFollowUpIndicesRef.current.add(i);
          savedParts.push(partLabel);
        } else {
          unsavedParts.push(partLabel);
        }
      }

      // 3. Apply accepted `stop` medication changes immediately via pauseMedication
      for (let i = 0; i < medChanges.length; i += 1) {
        const m = medChanges[i]!;
        if (m.decision !== 'accepted' || m.action !== 'stop') continue;
        const partLabel = en.visit.partStopMed.replace('{name}', m.name);
        if (savedStopIndicesRef.current.has(i)) {
          savedParts.push(partLabel);
          continue;
        }
        const pauseRes = await pauseMedFn(
          {
            circleId: circle.id,
            medicationId: m.medicationId,
            memberRole,
          },
          deps,
        );
        if (pauseRes.ok) {
          savedStopIndicesRef.current.add(i);
          savedParts.push(partLabel);
          anyMedPaused = true;
          setActiveMedications((prev) => prev.filter((med) => med.id !== m.medicationId));
        } else {
          unsavedParts.push(partLabel);
        }
      }

      if (anyMedPaused) {
        requestMedsReload();
        requestTodayReload();
      }

      if (unsavedParts.length > 0) {
        if (savedParts.length === 0) {
          setNotSavedNotice(true);
        } else {
          setPartialSaveState({ savedParts, unsavedParts });
        }
        return;
      }

      // Fire cc_visit_note_saved once with counts only ({ followUps, medChanges })
      if (!analyticsSentRef.current) {
        analyticsSentRef.current = true;
        const acceptedFollowUpsCount = followUps.filter((f) => f.decision === 'accepted').length;
        const acceptedMedChangesCount = medChanges.filter((m) => m.decision === 'accepted').length;
        try {
          trackFn({
            followUps: acceptedFollowUpsCount,
            medChanges: acceptedMedChangesCount,
          });
        } catch {
          // Never fail a confirmed save if analytics throws.
        }
      }

      // 4. Queue medication edit/add forms for accepted `change_dose` and `start` changes.
      // Nothing is written for `change_dose` or `start` until the user saves that form.
      const formsQueue = medChanges.filter(
        (m) => m.decision === 'accepted' && (m.action === 'change_dose' || m.action === 'start'),
      );
      if (formsQueue.length > 0) {
        setPendingMedForms(formsQueue);
        return;
      }

      onSaved?.();
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }, [
    allItemsDecided,
    appointmentId,
    circle,
    deps,
    draft,
    followUps,
    lastSubmittedTranscript,
    medChanges,
    memberRole,
    onSaved,
    summaryText,
  ]);

  const currentMedFormItem = pendingMedForms[0] ?? null;

  const currentMedFormInitialDraft = useMemo(() => {
    if (!currentMedFormItem) return draftFromMedication(null);
    if (currentMedFormItem.action === 'change_dose') {
      const existing = activeMedications.find((m) => m.id === currentMedFormItem.medicationId);
      if (existing) {
        return draftFromMedication(existing);
      }
      return {
        ...draftFromMedication(null),
        name: currentMedFormItem.name,
      };
    }
    return {
      ...draftFromMedication(null),
      name: currentMedFormItem.name,
    };
  }, [activeMedications, currentMedFormItem]);

  const handleSubmitPendingMedForm = useCallback(
    async (payload: ValidatedMedicationFormPayload): Promise<boolean> => {
      if (!currentMedFormItem || !circle) return false;
      setMedFormSaveFailed(false);

      const updateMedFn = deps?.updateMed ?? updateMedication;
      const addMedFn = deps?.addMed ?? addMedication;

      let res:
        | { ok: true; medication: Medication }
        | { ok: false; errorCode: MedsErrorCode; isOffline: boolean };

      if (currentMedFormItem.action === 'change_dose') {
        res = await updateMedFn(
          {
            circleId: circle.id,
            medicationId: currentMedFormItem.medicationId,
            ...payload,
            memberRole,
          },
          deps,
        );
      } else {
        res = await addMedFn(
          {
            circleId: circle.id,
            ...payload,
            memberRole,
            source: 'manual',
          },
          deps,
        );
      }

      if (!res.ok) {
        setMedFormSaveFailed(true);
        return false;
      }

      requestMedsReload();
      requestTodayReload();
      return true;
    },
    [activeMedications, circle, currentMedFormItem, deps, memberRole],
  );

  const handleAdvancePendingMedForm = useCallback(() => {
    setMedFormSaveFailed(false);
    setPendingMedForms((prev) => {
      const next = prev.slice(1);
      if (next.length === 0) {
        onSaved?.();
      }
      return next;
    });
  }, [onSaved]);

  const draftFields: DraftField[] = useMemo(
    () => [
      {
        label: en.visit.summaryLabel,
        value: summaryText,
        confidence: 1,
        testID: 'visit-draft-summary-input',
        onChangeValue: (next) => {
          setSummaryText(next);
          if (validationError) setValidationError(null);
        },
      },
    ],
    [summaryText, validationError],
  );

  return (
    <ScrollView
      testID="visit-new-screen"
      keyboardShouldPersistTaps="handled"
      style={[styles.screen, { backgroundColor: colors.background }]}
      contentContainerStyle={[
        styles.content,
        {
          padding: spacing.lg,
          gap: spacing.md,
        },
      ]}
    >
      <Header title={en.visit.title} subtitle={en.visit.subtitle} />

      {contextStatus === 'loading' ? (
        <View testID="visit-context-loading" style={[styles.statusRow, { gap: spacing.sm }]}>
          <ActivityIndicator color={colors.primary} />
          <Text style={[typography.body, { color: colors.textPrimary }]}>{en.visit.loading}</Text>
        </View>
      ) : null}

      {contextStatus === 'offline' || isOfflineNotice ? (
        <View testID="visit-offline">
          <ErrorState
            title={en.visit.offlineTitle}
            message={en.visit.offlineMessage}
            retryLabel={en.visit.retryCta}
            onRetry={() => {
              setIsOfflineNotice(false);
              setContextReloadKey((k) => k + 1);
            }}
          />
        </View>
      ) : null}

      {contextStatus === 'error' ? (
        <View testID="visit-context-error">
          <ErrorState
            title={en.visit.contextErrorTitle}
            message={en.visit.contextErrorMessage}
            retryLabel={en.visit.retryCta}
            onRetry={() => setContextReloadKey((k) => k + 1)}
          />
        </View>
      ) : null}

      {contextStatus === 'no_circle' ? (
        <View testID="visit-empty-state">
          <EmptyState title={en.visit.emptyTitle} message={en.visit.contextNoCircleMessage} />
        </View>
      ) : null}

      {contextStatus === 'ok' && !canEdit ? (
        <Card>
          <View style={{ gap: spacing.sm }}>
            <Text
              testID="visit-viewer-restricted"
              style={[typography.body, { color: colors.textSecondary }]}
            >
              {en.visit.viewerRestricted}
            </Text>
            {onViewerRedirect ? (
              <View testID="visit-viewer-back-button">
                <Button
                  variant="secondary"
                  label={en.visit.backCta}
                  accessibilityLabel={en.visit.backCta}
                  onPress={onViewerRedirect}
                />
              </View>
            ) : null}
          </View>
        </Card>
      ) : null}

      {canEdit && !draft && !currentMedFormItem ? (
        <Card>
          <View testID="visit-capture-section" style={{ gap: spacing.md }}>
            <View style={{ gap: spacing.xs }}>
              {!isRecording ? (
                <View testID="visit-record-button">
                  <Button
                    variant="secondary"
                    label={en.visit.recordCta}
                    accessibilityLabel={en.visit.recordCta}
                    disabled={isSummarising}
                    onPress={() => {
                      void handleStartRecording();
                    }}
                  />
                </View>
              ) : (
                <View style={{ gap: spacing.xs }}>
                  <Text
                    testID="visit-recording-timer"
                    style={[typography.subtitle, { color: colors.danger }]}
                  >
                    {en.visit.recordingTimerFormat
                      .replace('{elapsed}', formatDurationMmSs(elapsedMs))
                      .replace('{max}', formatDurationMmSs(MAX_VISIT_RECORDING_MS))}
                  </Text>
                  <View testID="visit-stop-record-button">
                    <Button
                      variant="danger"
                      label={en.visit.stopRecordingCta}
                      accessibilityLabel={en.visit.stopRecordingCta}
                      onPress={() => {
                        void handleStopRecording();
                      }}
                    />
                  </View>
                </View>
              )}

              {autoStoppedNotice ? (
                <Text
                  testID="visit-recording-autostopped"
                  style={[typography.caption, { color: colors.textSecondary }]}
                >
                  {en.visit.autoStoppedNotice}
                </Text>
              ) : null}

              {capturedRecording && !isRecording ? (
                <Text
                  testID="visit-recording-ready"
                  style={[typography.caption, { color: colors.textSecondary }]}
                >
                  {en.visit.recordingReady.replace(
                    '{duration}',
                    formatDurationMmSs(capturedRecording.durationMs),
                  )}
                </Text>
              ) : null}
            </View>

            <View style={{ gap: spacing.xs }}>
              <Text style={[typography.label, { color: colors.textPrimary }]}>
                {en.visit.typedNotesLabel}
              </Text>
              <TextInput
                testID="visit-notes-text-input"
                accessibilityLabel={en.visit.typedNotesLabel}
                placeholder={en.visit.typedNotesPlaceholder}
                placeholderTextColor={colors.textMuted}
                multiline
                editable={!isSummarising}
                value={typedText}
                onChangeText={setTypedText}
                style={[
                  styles.textArea,
                  {
                    backgroundColor: colors.surface,
                    borderColor: colors.border,
                    borderRadius: radii.md,
                    color: colors.textPrimary,
                    fontSize: typography.body.fontSize,
                    paddingHorizontal: spacing.md,
                    paddingVertical: spacing.sm,
                  },
                ]}
              />
            </View>

            <View testID="visit-summarise-button">
              <Button
                label={isSummarising ? en.visit.summarising : en.visit.summariseCta}
                accessibilityLabel={en.visit.summariseCta}
                disabled={
                  isRecording ||
                  isSummarising ||
                  (!capturedRecording && typedText.trim().length === 0)
                }
                onPress={() => {
                  void handleSummarise();
                }}
              />
            </View>

            {!isRecording && !capturedRecording && typedText.trim().length === 0 ? (
              <View testID="visit-empty-state">
                <EmptyState title={en.visit.emptyTitle} message={en.visit.emptyMessage} />
              </View>
            ) : null}
          </View>
        </Card>
      ) : null}

      {isSummarising ? (
        <View testID="visit-summarising" style={[styles.statusRow, { gap: spacing.sm }]}>
          <ActivityIndicator color={colors.primary} />
          <Text style={[typography.body, { color: colors.textPrimary }]}>
            {en.visit.summarising}
          </Text>
        </View>
      ) : null}

      {errorCode === 'QUOTA_EXCEEDED' ? (
        <Card>
          <View testID="visit-error-quota" style={{ gap: spacing.sm }}>
            <Text style={[typography.subtitle, { color: colors.danger }]}>
              {en.visit.errorQuotaTitle}
            </Text>
            <Text style={[typography.body, { color: colors.textSecondary }]}>
              {en.visit.errorQuotaMessage}
            </Text>
            <View testID="visit-quota-paywall-button">
              <Button
                label={en.visit.upgradeCta}
                accessibilityLabel={en.visit.upgradeCta}
                onPress={() => setPaywallVisible(true)}
              />
            </View>
          </View>
        </Card>
      ) : null}

      {errorCode === 'INPUT_INVALID' || errorCode === 'RECORDING_FAILED' ? (
        <Card>
          <View testID="visit-error-input-invalid" style={{ gap: spacing.xs }}>
            <Text style={[typography.subtitle, { color: colors.danger }]}>
              {en.visit.errorInputInvalidTitle}
            </Text>
            <Text style={[typography.body, { color: colors.textSecondary }]}>
              {en.visit.errorInputInvalidMessage}
            </Text>
          </View>
        </Card>
      ) : null}

      {errorCode === 'SCHEMA_INVALID' ? (
        <Card>
          <View testID="visit-error-schema-invalid" style={{ gap: spacing.xs }}>
            <Text style={[typography.subtitle, { color: colors.danger }]}>
              {en.visit.errorSchemaInvalidTitle}
            </Text>
            <Text style={[typography.body, { color: colors.textSecondary }]}>
              {en.visit.errorSchemaInvalidMessage}
            </Text>
          </View>
        </Card>
      ) : null}

      {errorCode === 'PROVIDER_ERROR' ? (
        <Card>
          <View testID="visit-error-provider" style={{ gap: spacing.sm }}>
            <Text style={[typography.subtitle, { color: colors.danger }]}>
              {en.visit.errorProviderTitle}
            </Text>
            <Text style={[typography.body, { color: colors.textSecondary }]}>
              {en.visit.errorProviderMessage}
            </Text>
            <View testID="visit-retry-button">
              <Button
                label={en.visit.retryCta}
                accessibilityLabel={en.visit.retryCta}
                onPress={() => {
                  void handleSummarise();
                }}
              />
            </View>
          </View>
        </Card>
      ) : null}

      {errorCode === 'AUDIO_PERMISSION_DENIED' ? (
        <Card>
          <View testID="visit-error-permission" style={{ gap: spacing.xs }}>
            <Text style={[typography.subtitle, { color: colors.danger }]}>
              {en.visit.errorPermissionTitle}
            </Text>
            <Text style={[typography.body, { color: colors.textSecondary }]}>
              {en.visit.errorPermissionMessage}
            </Text>
          </View>
        </Card>
      ) : null}

      {notSavedNotice ? (
        <Card>
          <View testID="visit-not-saved-notice" style={{ gap: spacing.xs }}>
            <Text style={[typography.subtitle, { color: colors.danger }]}>
              {en.visit.notSavedTitle}
            </Text>
            <Text style={[typography.body, { color: colors.textSecondary }]}>
              {en.visit.notSavedMessage}
            </Text>
          </View>
        </Card>
      ) : null}

      {partialSaveState ? (
        <Card tone="warning">
          <View testID="visit-partial-save-notice" style={{ gap: spacing.xs }}>
            <Text style={[typography.subtitle, { color: colors.onWarningSurface }]}>
              {en.visit.partialSaveTitle}
            </Text>
            <Text
              testID="visit-saved-parts"
              style={[typography.bodySmall, { color: colors.onWarningSurface }]}
            >
              {`${en.visit.partialSaveSavedPrefix}${partialSaveState.savedParts.join(', ')}`}
            </Text>
            <Text
              testID="visit-unsaved-parts"
              style={[typography.bodySmall, { color: colors.onWarningSurface }]}
            >
              {`${en.visit.partialSaveUnsavedPrefix}${partialSaveState.unsavedParts.join(', ')}`}
            </Text>
          </View>
        </Card>
      ) : null}

      {medFormSaveFailed ? (
        <Card>
          <View testID="meds-not-saved-notice" style={{ gap: spacing.xs }}>
            <Text style={[typography.subtitle, { color: colors.danger }]}>
              {en.meds.notSavedTitle}
            </Text>
            <Text style={[typography.body, { color: colors.textSecondary }]}>
              {en.meds.notSavedMessage}
            </Text>
          </View>
        </Card>
      ) : null}

      {canEdit && currentMedFormItem ? (
        <MedicationFormCard
          key={`${currentMedFormItem.action}-${currentMedFormItem.medicationId ?? currentMedFormItem.name}`}
          initialDraft={currentMedFormInitialDraft}
          isEdit={currentMedFormItem.action === 'change_dose'}
          topNotice={{
            title:
              currentMedFormItem.action === 'change_dose'
                ? en.visit.medActionChangeDose.replace('{name}', currentMedFormItem.name)
                : en.visit.medActionStart.replace('{name}', currentMedFormItem.name),
            detail: currentMedFormItem.detail ?? en.visit.medFormChangeBannerTitle,
            testID: 'visit-med-form-change-banner',
          }}
          onSubmit={handleSubmitPendingMedForm}
          onCancel={handleAdvancePendingMedForm}
        />
      ) : null}

      {canEdit && draft && !currentMedFormItem ? (
        <View testID="visit-draft-review" style={{ gap: spacing.sm }}>
          <Text style={[typography.subtitle, { color: colors.textPrimary }]}>
            {en.visit.reviewHeading}
          </Text>
          <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>
            {en.visit.reviewSubheading}
          </Text>

          <ConfirmDraft
            key="visit-draft"
            fields={draftFields}
            saveLabel={isSaving ? en.visit.savingCta : en.visit.saveCta}
            lowConfidenceLabel=""
            saveTestID="visit-save-button"
            disabled={!allItemsDecided || isSaving}
            onConfirm={() => {
              void handleSave();
            }}
          >
            <View testID="visit-followups-section" style={{ gap: spacing.sm }}>
              <Text style={[typography.subtitle, { color: colors.textPrimary }]}>
                {en.visit.followUpsHeading}
              </Text>
              {followUps.length === 0 ? (
                <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>
                  {en.visit.noFollowUps}
                </Text>
              ) : (
                followUps.map((item, idx) => (
                  <Card key={`followup-${idx}`}>
                    <View testID={`visit-followup-${idx}`} style={{ gap: spacing.xs }}>
                      <Text style={[typography.label, { color: colors.textPrimary }]}>
                        {en.visit.followUpTitleLabel}
                      </Text>
                      <TextInput
                        testID={`visit-followup-title-${idx}`}
                        accessibilityLabel={`${en.visit.followUpTitleLabel} ${idx + 1}`}
                        value={item.title}
                        onChangeText={(next) => {
                          setFollowUps((prev) =>
                            prev.map((f, i) => (i === idx ? { ...f, title: next } : f)),
                          );
                          if (validationError) setValidationError(null);
                        }}
                        style={[
                          styles.input,
                          {
                            backgroundColor: colors.surface,
                            borderColor: colors.border,
                            borderRadius: radii.md,
                            color: colors.textPrimary,
                            fontSize: typography.body.fontSize,
                            paddingHorizontal: spacing.md,
                            paddingVertical: spacing.sm,
                          },
                        ]}
                      />

                      <Text style={[typography.label, { color: colors.textPrimary }]}>
                        {en.visit.followUpDueDateLabel}
                      </Text>
                      <TextInput
                        testID={`visit-followup-due-date-${idx}`}
                        accessibilityLabel={`${en.visit.followUpDueDateLabel} ${idx + 1}`}
                        placeholder={en.visit.followUpDueDatePlaceholder}
                        placeholderTextColor={colors.textMuted}
                        autoCapitalize="none"
                        autoCorrect={false}
                        value={item.dueDate}
                        onChangeText={(next) => {
                          setFollowUps((prev) =>
                            prev.map((f, i) => (i === idx ? { ...f, dueDate: next } : f)),
                          );
                          if (validationError) setValidationError(null);
                        }}
                        style={[
                          styles.input,
                          {
                            backgroundColor: colors.surface,
                            borderColor: colors.border,
                            borderRadius: radii.md,
                            color: colors.textPrimary,
                            fontSize: typography.body.fontSize,
                            paddingHorizontal: spacing.md,
                            paddingVertical: spacing.sm,
                          },
                        ]}
                      />

                      {item.dueHint ? (
                        <Text style={[typography.caption, { color: colors.textSecondary }]}>
                          {item.dueHint}
                        </Text>
                      ) : null}

                      <View style={[styles.decisionRow, { gap: spacing.xs }]}>
                        <View testID={`visit-followup-accept-${idx}`} style={styles.flexButton}>
                          <Button
                            variant={item.decision === 'accepted' ? 'primary' : 'secondary'}
                            label={en.visit.acceptCta}
                            accessibilityLabel={`${en.visit.acceptCta} ${item.title}`}
                            onPress={() => {
                              setFollowUps((prev) =>
                                prev.map((f, i) =>
                                  i === idx ? { ...f, decision: 'accepted' } : f,
                                ),
                              );
                            }}
                          />
                        </View>
                        <View testID={`visit-followup-reject-${idx}`} style={styles.flexButton}>
                          <Button
                            variant={item.decision === 'rejected' ? 'danger' : 'secondary'}
                            label={en.visit.rejectCta}
                            accessibilityLabel={`${en.visit.rejectCta} ${item.title}`}
                            onPress={() => {
                              setFollowUps((prev) =>
                                prev.map((f, i) =>
                                  i === idx ? { ...f, decision: 'rejected' } : f,
                                ),
                              );
                            }}
                          />
                        </View>
                      </View>
                    </View>
                  </Card>
                ))
              )}
            </View>

            <View testID="visit-med-changes-section" style={{ gap: spacing.sm }}>
              <Text style={[typography.subtitle, { color: colors.textPrimary }]}>
                {en.visit.medChangesHeading}
              </Text>
              {medChanges.length === 0 ? (
                <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>
                  {en.visit.noMedChanges}
                </Text>
              ) : (
                medChanges.map((change, idx) => {
                  const actionTitle =
                    change.action === 'stop'
                      ? en.visit.medActionStop.replace('{name}', change.name)
                      : change.action === 'change_dose'
                        ? en.visit.medActionChangeDose.replace('{name}', change.name)
                        : en.visit.medActionStart.replace('{name}', change.name);

                  return (
                    <Card key={`med-change-${idx}`}>
                      <View testID={`visit-med-change-${idx}`} style={{ gap: spacing.xs }}>
                        <View style={styles.rowBetween}>
                          <Text
                            testID={`visit-med-change-label-${idx}`}
                            style={[typography.subtitle, { color: colors.textPrimary }]}
                          >
                            {actionTitle}
                          </Text>
                          {change.decision ? (
                            <Chip
                              label={
                                change.decision === 'accepted'
                                  ? en.visit.acceptedBadge
                                  : en.visit.rejectedBadge
                              }
                              tone={change.decision === 'accepted' ? 'primary' : 'warning'}
                            />
                          ) : null}
                        </View>

                        {change.detail ? (
                          <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>
                            {change.detail}
                          </Text>
                        ) : null}

                        <View style={[styles.decisionRow, { gap: spacing.xs }]}>
                          <View testID={`visit-med-change-accept-${idx}`} style={styles.flexButton}>
                            <Button
                              variant={change.decision === 'accepted' ? 'primary' : 'secondary'}
                              label={en.visit.acceptCta}
                              accessibilityLabel={`${en.visit.acceptCta} ${actionTitle}`}
                              onPress={() => {
                                setMedChanges((prev) =>
                                  prev.map((m, i) =>
                                    i === idx ? { ...m, decision: 'accepted' } : m,
                                  ),
                                );
                              }}
                            />
                          </View>
                          <View testID={`visit-med-change-reject-${idx}`} style={styles.flexButton}>
                            <Button
                              variant={change.decision === 'rejected' ? 'danger' : 'secondary'}
                              label={en.visit.rejectCta}
                              accessibilityLabel={`${en.visit.rejectCta} ${actionTitle}`}
                              onPress={() => {
                                setMedChanges((prev) =>
                                  prev.map((m, i) =>
                                    i === idx ? { ...m, decision: 'rejected' } : m,
                                  ),
                                );
                              }}
                            />
                          </View>
                        </View>
                      </View>
                    </Card>
                  );
                })
              )}
            </View>

            <View testID="visit-questions-section" style={{ gap: spacing.xs }}>
              <Text style={[typography.subtitle, { color: colors.textPrimary }]}>
                {en.visit.questionsHeading}
              </Text>
              {questionsToAsk.length === 0 ? (
                <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>
                  {en.visit.noQuestions}
                </Text>
              ) : (
                questionsToAsk.map((q, idx) => (
                  <Text
                    key={`question-${idx}`}
                    testID={`visit-question-${idx}`}
                    style={[typography.body, { color: colors.textPrimary }]}
                  >
                    {`• ${q}`}
                  </Text>
                ))
              )}
            </View>

            {!allItemsDecided ? (
              <Text
                testID="visit-decide-all-hint"
                style={[typography.caption, { color: colors.textSecondary }]}
              >
                {en.visit.decideAllHint}
              </Text>
            ) : null}

            {validationError ? (
              <Text
                testID="visit-validation-error"
                style={[typography.caption, { color: colors.danger }]}
              >
                {validationError}
              </Text>
            ) : null}
          </ConfirmDraft>
        </View>
      ) : null}

      <Text
        testID="visit-not-medical-advice"
        style={[typography.caption, { color: colors.textMuted }]}
      >
        {en.common.notMedicalAdvice}
      </Text>

      <PaywallSheet
        visible={paywallVisible}
        trigger="visit_note"
        onClose={() => setPaywallVisible(false)}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  decisionRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  flexButton: {
    flex: 1,
  },
  input: {
    minHeight: MIN_TOUCH_TARGET_PT,
    minWidth: MIN_TOUCH_TARGET_PT,
    borderWidth: 1,
  },
  textArea: {
    minHeight: 96,
    minWidth: MIN_TOUCH_TARGET_PT,
    borderWidth: 1,
    textAlignVertical: 'top',
  },
});
