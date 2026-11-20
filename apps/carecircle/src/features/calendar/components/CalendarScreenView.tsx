import type { Appointment, MemberRole } from '@carecircle/core';
import {
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Header,
  MIN_TOUCH_TARGET_PT,
  useTheme,
} from '@carecircle/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import en from '../../../../i18n/en.json';
import { formatLocalDateInZone, formatLocalTimeInZone } from '../../today/api';
import {
  extractLocalAppointmentFormFields,
  validateAppointmentDraft,
  type CalendarMemberOption,
} from '../api';

export interface AppointmentFormDraft {
  title: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  location: string;
  notes: string;
  driverUserId: string | null;
}

export interface CalendarScreenViewProps {
  circleId?: string;
  circleTitle?: string;
  circleTimezone?: string;
  memberRole?: MemberRole;
  members?: ReadonlyArray<CalendarMemberOption>;
  appointments?: ReadonlyArray<Appointment>;
  initialSelectedDate?: string;
  isLoading?: boolean;
  hasError?: boolean;
  isOffline?: boolean;
  notSavedNotice?: boolean;
  onRetry?: () => void;
  onSaveAppointment?: (
    draft: AppointmentFormDraft,
    editingAppointmentId: string | null,
  ) => Promise<boolean> | boolean;
  onDeleteAppointment?: (appointmentId: string) => Promise<boolean> | boolean;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const WEEKDAY_HEADERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

function parseYearMonth(dateStr: string): { year: number; month: number } {
  const match = /^(\d{4})-(\d{2})/.exec(dateStr);
  if (!match) {
    return { year: 2026, month: 11 };
  }
  return {
    year: Number.parseInt(match[1]!, 10),
    month: Number.parseInt(match[2]!, 10),
  };
}

function buildMonthCells(year: number, month: number): Array<string | null> {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const firstUtcDay = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  // Monday = 0 ... Sunday = 6
  const leadingBlanks = (firstUtcDay + 6) % 7;
  const cells: Array<string | null> = [];
  for (let i = 0; i < leadingBlanks; i += 1) {
    cells.push(null);
  }
  const ym = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
  for (let d = 1; d <= daysInMonth; d += 1) {
    cells.push(`${ym}-${String(d).padStart(2, '0')}`);
  }
  return cells;
}

function shiftMonth(year: number, month: number, delta: -1 | 1): { year: number; month: number } {
  let nextMonth = month + delta;
  let nextYear = year;
  if (nextMonth < 1) {
    nextMonth = 12;
    nextYear -= 1;
  } else if (nextMonth > 12) {
    nextMonth = 1;
    nextYear += 1;
  }
  return { year: nextYear, month: nextMonth };
}

export function CalendarScreenView({
  circleId = '',
  circleTitle,
  circleTimezone = 'UTC',
  memberRole = 'viewer',
  members = [],
  appointments = [],
  initialSelectedDate = '2026-11-15',
  isLoading = false,
  hasError = false,
  isOffline = false,
  notSavedNotice = false,
  onRetry,
  onSaveAppointment,
  onDeleteAppointment,
}: CalendarScreenViewProps) {
  const { colors, radii, spacing, typography } = useTheme();
  const canEdit = memberRole === 'owner' || memberRole === 'helper';

  const [selectedDate, setSelectedDate] = useState(initialSelectedDate);
  const [{ year: viewYear, month: viewMonth }, setViewYearMonth] = useState(() =>
    parseYearMonth(initialSelectedDate),
  );

  const [formOpen, setFormOpen] = useState(false);
  const [editingApptId, setEditingApptId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [startDate, setStartDate] = useState(initialSelectedDate);
  const [startTime, setStartTime] = useState('09:00');
  const [endDate, setEndDate] = useState('');
  const [endTime, setEndTime] = useState('');
  const [location, setLocation] = useState('');
  const [notes, setNotes] = useState('');
  const [driverUserId, setDriverUserId] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [endBeforeStartError, setEndBeforeStartError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  useEffect(() => {
    if (!canEdit) {
      setFormOpen(false);
      setEditingApptId(null);
      setConfirmingDeleteId(null);
    }
  }, [canEdit]);

  const datesWithAppointments = useMemo(() => {
    const set = new Set<string>();
    for (const appt of appointments) {
      set.add(formatLocalDateInZone(appt.startsAt, circleTimezone));
    }
    return set;
  }, [appointments, circleTimezone]);

  const monthCells = useMemo(() => buildMonthCells(viewYear, viewMonth), [viewMonth, viewYear]);

  const agendaAppointments = useMemo(() => {
    return appointments
      .filter((appt) => formatLocalDateInZone(appt.startsAt, circleTimezone) >= selectedDate)
      .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  }, [appointments, circleTimezone, selectedDate]);

  const memberDisplayById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) {
      map.set(m.userId, m.displayName);
    }
    return map;
  }, [members]);

  const openAddForm = useCallback(() => {
    setEditingApptId(null);
    setTitle('');
    setStartDate(selectedDate);
    setStartTime('09:00');
    setEndDate('');
    setEndTime('');
    setLocation('');
    setNotes('');
    setDriverUserId(null);
    setValidationError(null);
    setEndBeforeStartError(null);
    setFormOpen(true);
  }, [selectedDate]);

  const openEditForm = useCallback(
    (appt: Appointment) => {
      const fields = extractLocalAppointmentFormFields(appt, circleTimezone);
      setEditingApptId(appt.id);
      setTitle(fields.title);
      setStartDate(fields.startDate);
      setStartTime(fields.startTime);
      setEndDate(fields.endDate);
      setEndTime(fields.endTime);
      setLocation(fields.location);
      setNotes(fields.notes);
      setDriverUserId(fields.driverUserId);
      setValidationError(null);
      setEndBeforeStartError(null);
      setFormOpen(true);
    },
    [circleTimezone],
  );

  const closeForm = useCallback(() => {
    setFormOpen(false);
    setEditingApptId(null);
    setValidationError(null);
    setEndBeforeStartError(null);
  }, []);

  const handleSubmitForm = useCallback(async () => {
    if (submitting) return;
    setValidationError(null);
    setEndBeforeStartError(null);

    const validated = validateAppointmentDraft({
      circleId: circleId || '00000000-0000-4000-8000-000000000001',
      timezone: circleTimezone,
      title,
      startDate,
      startTime,
      endDate,
      endTime,
      location,
      notes,
      driverUserId,
    });

    if (!validated.ok) {
      if (validated.errorCode === 'END_BEFORE_START') {
        setEndBeforeStartError(validated.message);
      } else {
        setValidationError(validated.message);
      }
      return;
    }

    if (!onSaveAppointment) {
      closeForm();
      return;
    }

    setSubmitting(true);
    try {
      const ok = await onSaveAppointment(
        {
          title,
          startDate,
          startTime,
          endDate,
          endTime,
          location,
          notes,
          driverUserId,
        },
        editingApptId,
      );
      if (ok) {
        closeForm();
      }
    } finally {
      setSubmitting(false);
    }
  }, [
    circleId,
    circleTimezone,
    closeForm,
    driverUserId,
    editingApptId,
    endDate,
    endTime,
    location,
    notes,
    onSaveAppointment,
    startDate,
    startTime,
    submitting,
    title,
  ]);

  const showStatusOnly = isLoading || hasError || isOffline;

  return (
    <ScrollView
      testID="calendar-screen"
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
      <Header title={circleTitle ? `${en.calendar.title} · ${circleTitle}` : en.calendar.title} />

      {isLoading ? (
        <View testID="calendar-loading" style={[styles.statusRow, { gap: spacing.sm }]}>
          <ActivityIndicator color={colors.primary} />
          <Text style={[typography.body, { color: colors.textPrimary }]}>
            {en.calendar.loading}
          </Text>
        </View>
      ) : null}

      {isOffline ? (
        <View testID="calendar-offline">
          <ErrorState
            title={en.calendar.offlineTitle}
            message={en.calendar.offlineMessage}
            retryLabel={en.calendar.retry}
            onRetry={() => onRetry?.()}
          />
        </View>
      ) : null}

      {hasError && !isOffline ? (
        <View testID="calendar-error">
          <ErrorState
            title={en.calendar.errorTitle}
            message={en.calendar.errorMessage}
            retryLabel={en.calendar.retry}
            onRetry={() => onRetry?.()}
          />
        </View>
      ) : null}

      {notSavedNotice ? (
        <Card>
          <View testID="calendar-not-saved-notice" style={{ gap: spacing.xs }}>
            <Text style={[typography.subtitle, { color: colors.danger }]}>
              {en.calendar.notSavedTitle}
            </Text>
            <Text style={[typography.body, { color: colors.textSecondary }]}>
              {en.calendar.notSavedMessage}
            </Text>
          </View>
        </Card>
      ) : null}

      {!showStatusOnly ? (
        <Card>
          <View testID="calendar-month-grid" style={{ gap: spacing.sm }}>
            <View style={styles.rowBetween}>
              <View testID="calendar-prev-month-button">
                <Button
                  variant="secondary"
                  label="‹"
                  accessibilityLabel={en.calendar.prevMonthA11y}
                  onPress={() => {
                    const prev = shiftMonth(viewYear, viewMonth, -1);
                    setViewYearMonth(prev);
                    setSelectedDate(
                      `${String(prev.year).padStart(4, '0')}-${String(prev.month).padStart(2, '0')}-01`,
                    );
                  }}
                />
              </View>
              <Text
                testID="calendar-month-label"
                style={[typography.subtitle, { color: colors.textPrimary }]}
              >
                {`${MONTH_NAMES[viewMonth - 1] ?? ''} ${viewYear}`}
              </Text>
              <View testID="calendar-next-month-button">
                <Button
                  variant="secondary"
                  label="›"
                  accessibilityLabel={en.calendar.nextMonthA11y}
                  onPress={() => {
                    const next = shiftMonth(viewYear, viewMonth, 1);
                    setViewYearMonth(next);
                    setSelectedDate(
                      `${String(next.year).padStart(4, '0')}-${String(next.month).padStart(2, '0')}-01`,
                    );
                  }}
                />
              </View>
            </View>

            <View style={styles.weekRow}>
              {WEEKDAY_HEADERS.map((wd) => (
                <View key={wd} style={styles.dayCell}>
                  <Text style={[typography.caption, { color: colors.textSecondary }]}>{wd}</Text>
                </View>
              ))}
            </View>

            <View style={styles.monthCellsWrap}>
              {monthCells.map((dateStr, idx) => {
                if (!dateStr) {
                  return <View key={`blank-${idx}`} style={styles.dayCell} />;
                }
                const dayNumber = Number.parseInt(dateStr.slice(8, 10), 10);
                const isSelected = dateStr === selectedDate;
                const hasAppt = datesWithAppointments.has(dateStr);

                return (
                  <Pressable
                    key={dateStr}
                    testID={`calendar-day-${dateStr}`}
                    accessibilityRole="button"
                    accessibilityLabel={dateStr}
                    accessibilityState={{ selected: isSelected }}
                    onPress={() => setSelectedDate(dateStr)}
                    style={[
                      styles.dayCell,
                      styles.dayPressable,
                      {
                        backgroundColor: isSelected ? colors.primary : 'transparent',
                        borderRadius: radii.md,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        typography.bodySmall,
                        { color: isSelected ? colors.onPrimary : colors.textPrimary },
                      ]}
                    >
                      {String(dayNumber)}
                    </Text>
                    {hasAppt ? (
                      <View
                        testID={`calendar-dot-${dateStr}`}
                        style={[
                          styles.dot,
                          {
                            backgroundColor: isSelected ? colors.onPrimary : colors.primary,
                          },
                        ]}
                      />
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          </View>
        </Card>
      ) : null}

      {!showStatusOnly && canEdit && !formOpen ? (
        <View testID="calendar-add-button">
          <Button
            label={en.calendar.addCta}
            accessibilityLabel={en.calendar.addA11y}
            onPress={openAddForm}
          />
        </View>
      ) : null}

      {!showStatusOnly && canEdit && formOpen ? (
        <Card>
          <View testID="calendar-form" style={{ gap: spacing.sm }}>
            <Text style={[typography.subtitle, { color: colors.textPrimary }]}>
              {editingApptId ? en.calendar.formEditTitle : en.calendar.formAddTitle}
            </Text>

            <Text style={[typography.body, { color: colors.textPrimary }]}>
              {en.calendar.titleLabel}
            </Text>
            <TextInput
              testID="calendar-title-input"
              accessibilityLabel={en.calendar.titleLabel}
              placeholder={en.calendar.titlePlaceholder}
              placeholderTextColor={colors.textMuted}
              editable={!submitting}
              value={title}
              onChangeText={(next) => {
                setTitle(next);
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

            <Text style={[typography.body, { color: colors.textPrimary }]}>
              {en.calendar.startDateLabel}
            </Text>
            <TextInput
              testID="calendar-start-date-input"
              accessibilityLabel={en.calendar.startDateLabel}
              placeholder={en.calendar.startDatePlaceholder}
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!submitting}
              value={startDate}
              onChangeText={(next) => {
                setStartDate(next);
                if (validationError) setValidationError(null);
                if (endBeforeStartError) setEndBeforeStartError(null);
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

            <Text style={[typography.body, { color: colors.textPrimary }]}>
              {en.calendar.startTimeLabel}
            </Text>
            <TextInput
              testID="calendar-start-time-input"
              accessibilityLabel={en.calendar.startTimeLabel}
              placeholder={en.calendar.startTimePlaceholder}
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!submitting}
              value={startTime}
              onChangeText={(next) => {
                setStartTime(next);
                if (validationError) setValidationError(null);
                if (endBeforeStartError) setEndBeforeStartError(null);
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

            <Text style={[typography.body, { color: colors.textPrimary }]}>
              {en.calendar.endDateLabel}
            </Text>
            <TextInput
              testID="calendar-end-date-input"
              accessibilityLabel={en.calendar.endDateLabel}
              placeholder={en.calendar.endDatePlaceholder}
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!submitting}
              value={endDate}
              onChangeText={(next) => {
                setEndDate(next);
                if (validationError) setValidationError(null);
                if (endBeforeStartError) setEndBeforeStartError(null);
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

            <Text style={[typography.body, { color: colors.textPrimary }]}>
              {en.calendar.endTimeLabel}
            </Text>
            <TextInput
              testID="calendar-end-time-input"
              accessibilityLabel={en.calendar.endTimeLabel}
              placeholder={en.calendar.endTimePlaceholder}
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!submitting}
              value={endTime}
              onChangeText={(next) => {
                setEndTime(next);
                if (validationError) setValidationError(null);
                if (endBeforeStartError) setEndBeforeStartError(null);
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

            {endBeforeStartError ? (
              <Text
                testID="calendar-end-before-start-error"
                style={[typography.caption, { color: colors.danger }]}
              >
                {endBeforeStartError}
              </Text>
            ) : null}

            <Text style={[typography.body, { color: colors.textPrimary }]}>
              {en.calendar.locationLabel}
            </Text>
            <TextInput
              testID="calendar-location-input"
              accessibilityLabel={en.calendar.locationLabel}
              placeholder={en.calendar.locationPlaceholder}
              placeholderTextColor={colors.textMuted}
              editable={!submitting}
              value={location}
              onChangeText={setLocation}
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

            <Text style={[typography.body, { color: colors.textPrimary }]}>
              {en.calendar.notesLabel}
            </Text>
            <TextInput
              testID="calendar-notes-input"
              accessibilityLabel={en.calendar.notesLabel}
              placeholder={en.calendar.notesPlaceholder}
              placeholderTextColor={colors.textMuted}
              editable={!submitting}
              value={notes}
              onChangeText={setNotes}
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

            <Text style={[typography.body, { color: colors.textPrimary }]}>
              {en.calendar.driverLabel}
            </Text>
            <View testID="calendar-driver-picker" style={[styles.driverRow, { gap: spacing.xs }]}>
              <View testID="calendar-driver-option-none">
                <Chip
                  label={en.calendar.driverNone}
                  accessibilityLabel={`${en.calendar.driverLabel}: ${en.calendar.driverNone}`}
                  selected={driverUserId === null}
                  onPress={() => setDriverUserId(null)}
                />
              </View>
              {members.map((m) => (
                <View key={m.userId} testID={`calendar-driver-option-${m.userId}`}>
                  <Chip
                    label={m.displayName}
                    accessibilityLabel={`${en.calendar.driverLabel}: ${m.displayName}`}
                    selected={driverUserId === m.userId}
                    onPress={() => setDriverUserId(m.userId)}
                  />
                </View>
              ))}
            </View>

            {validationError ? (
              <Text
                testID="calendar-form-validation-error"
                style={[typography.caption, { color: colors.danger }]}
              >
                {validationError}
              </Text>
            ) : null}

            <View style={[styles.formActions, { gap: spacing.sm }]}>
              <View testID="calendar-save-button" style={styles.actionButton}>
                <Button
                  label={en.calendar.saveCta}
                  accessibilityLabel={en.calendar.saveCta}
                  disabled={submitting}
                  onPress={() => {
                    void handleSubmitForm();
                  }}
                />
              </View>
              <View testID="calendar-cancel-button" style={styles.actionButton}>
                <Button
                  variant="secondary"
                  label={en.calendar.cancelCta}
                  accessibilityLabel={en.calendar.cancelCta}
                  disabled={submitting}
                  onPress={closeForm}
                />
              </View>
            </View>
          </View>
        </Card>
      ) : null}

      {!showStatusOnly ? (
        <View testID="calendar-agenda-list" style={{ gap: spacing.sm }}>
          <Text style={[typography.subtitle, { color: colors.textPrimary }]}>
            {en.calendar.agendaHeading}
          </Text>

          {agendaAppointments.length === 0 ? (
            <View testID="calendar-empty-state">
              <EmptyState title={en.calendar.emptyTitle} message={en.calendar.emptyMessage} />
            </View>
          ) : (
            agendaAppointments.map((appt) => {
              const localDate = formatLocalDateInZone(appt.startsAt, circleTimezone);
              const localStart = formatLocalTimeInZone(appt.startsAt, circleTimezone);
              const localEnd = appt.endsAt
                ? formatLocalTimeInZone(appt.endsAt, circleTimezone)
                : null;
              const timeSummary = localEnd
                ? `${localDate} · ${localStart} – ${localEnd}`
                : `${localDate} · ${localStart}`;
              const driverName = appt.driverUserId
                ? (memberDisplayById.get(appt.driverUserId) ?? en.circle.defaultMemberName)
                : null;

              return (
                <Card key={appt.id}>
                  <View testID={`calendar-item-${appt.id}`} style={{ gap: spacing.xs }}>
                    <Text style={[typography.subtitle, { color: colors.textPrimary }]}>
                      {appt.title}
                    </Text>
                    <Text
                      testID={`calendar-item-time-${appt.id}`}
                      style={[typography.bodySmall, { color: colors.textSecondary }]}
                    >
                      {timeSummary}
                    </Text>
                    {appt.location ? (
                      <Text style={[typography.bodySmall, { color: colors.textPrimary }]}>
                        {appt.location}
                      </Text>
                    ) : null}
                    {driverName ? (
                      <Text
                        testID={`calendar-item-driver-${appt.id}`}
                        style={[typography.caption, { color: colors.textSecondary }]}
                      >
                        {en.calendar.driverPrefix.replace('{name}', driverName)}
                      </Text>
                    ) : null}
                    {appt.notes ? (
                      <Text style={[typography.caption, { color: colors.textSecondary }]}>
                        {appt.notes}
                      </Text>
                    ) : null}

                    {canEdit ? (
                      confirmingDeleteId === appt.id ? (
                        <View style={{ gap: spacing.xs }}>
                          <Text
                            testID={`calendar-delete-prompt-${appt.id}`}
                            style={[typography.bodySmall, { color: colors.danger }]}
                          >
                            {en.calendar.deleteConfirmPrompt}
                          </Text>
                          <View style={[styles.itemActions, { gap: spacing.xs }]}>
                            <View testID={`calendar-confirm-delete-${appt.id}`}>
                              <Button
                                variant="danger"
                                label={en.calendar.confirmDeleteCta}
                                accessibilityLabel={`${en.calendar.confirmDeleteCta} ${appt.title}`}
                                onPress={() => {
                                  setConfirmingDeleteId(null);
                                  void onDeleteAppointment?.(appt.id);
                                }}
                              />
                            </View>
                            <View testID={`calendar-cancel-delete-${appt.id}`}>
                              <Button
                                variant="secondary"
                                label={en.calendar.cancelDeleteCta}
                                accessibilityLabel={`${en.calendar.cancelDeleteCta} ${appt.title}`}
                                onPress={() => setConfirmingDeleteId(null)}
                              />
                            </View>
                          </View>
                        </View>
                      ) : (
                        <View style={[styles.itemActions, { gap: spacing.xs }]}>
                          <View testID={`calendar-edit-${appt.id}`}>
                            <Button
                              variant="secondary"
                              label={en.calendar.editCta}
                              accessibilityLabel={`${en.calendar.editCta} ${appt.title}`}
                              onPress={() => openEditForm(appt)}
                            />
                          </View>
                          <View testID={`calendar-delete-${appt.id}`}>
                            <Button
                              variant="secondary"
                              label={en.calendar.deleteCta}
                              accessibilityLabel={`${en.calendar.deleteCta} ${appt.title}`}
                              onPress={() => setConfirmingDeleteId(appt.id)}
                            />
                          </View>
                        </View>
                      )
                    ) : null}
                  </View>
                </Card>
              );
            })
          )}
        </View>
      ) : null}
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
  weekRow: {
    flexDirection: 'row',
  },
  monthCellsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  dayCell: {
    width: '14.2857%',
    minHeight: MIN_TOUCH_TARGET_PT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayPressable: {
    minWidth: MIN_TOUCH_TARGET_PT,
    paddingVertical: 4,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginTop: 2,
  },
  input: {
    minHeight: MIN_TOUCH_TARGET_PT,
    minWidth: MIN_TOUCH_TARGET_PT,
    borderWidth: 1,
  },
  driverRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  formActions: {
    flexDirection: 'row',
  },
  actionButton: {
    flex: 1,
  },
  itemActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
});
