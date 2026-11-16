import {
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Header,
  ListRow,
  Screen,
  useTheme,
  type ChipTone,
} from '@carecircle/ui';
import type { DoseStatus } from '@carecircle/core';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import en from '../../../../i18n/en.json';
import {
  formatLocalDateInZone,
  formatLocalTimeInZone,
  type TodayAgenda,
  type TodayDoseStatusAction,
} from '../api';

/** A short message above the agenda: a check-off was not saved, or the server refused a queued one. */
export type TodayNotice = 'checkOffFailed' | 'refused';

export interface TodayScreenViewProps {
  circleTitle?: string;
  agenda?: TodayAgenda | null;
  isLoading?: boolean;
  hasError?: boolean;
  isOffline?: boolean;
  queuedCount?: number;
  notice?: TodayNotice | null;
  onRetry?: () => void;
  onCheckOffDose?: (doseEventId: string, status: TodayDoseStatusAction) => void;
  onOpenAppointment?: (appointmentId: string) => void;
  onOpenTask?: (taskId: string) => void;
}

function doseStatusLabel(status: DoseStatus): string {
  switch (status) {
    case 'given':
      return en.today.statusGiven;
    case 'skipped':
      return en.today.statusSkipped;
    case 'missed':
      return en.today.statusMissed;
    default:
      return en.today.statusPending;
  }
}

function doseStatusTone(status: DoseStatus): ChipTone {
  switch (status) {
    case 'given':
      return 'primary';
    case 'skipped':
      return 'warning';
    case 'missed':
      return 'danger';
    default:
      return 'default';
  }
}

export function TodayScreenView({
  circleTitle,
  agenda = null,
  isLoading = false,
  hasError = false,
  isOffline = false,
  queuedCount = 0,
  notice = null,
  onRetry,
  onCheckOffDose,
  onOpenAppointment,
  onOpenTask,
}: TodayScreenViewProps) {
  const { colors, spacing, typography } = useTheme();
  // Unknown role: no edit buttons (the server refuses a viewer's writes anyway).
  const canEditDoses = agenda?.memberRole === 'owner' || agenda?.memberRole === 'helper';

  return (
    <Screen accessibilityLabel={en.today.title}>
      <View testID="today-screen" style={[styles.container, { gap: spacing.md }]}>
        <Header title={en.today.title} subtitle={circleTitle} />

        {isLoading ? (
          <View testID="today-loading">
            <Card tone="muted" accessibilityLabel={en.today.loading}>
              <View style={[styles.loadingRow, { gap: spacing.sm }]}>
                <ActivityIndicator color={colors.primary} />
                <Text style={[typography.body, { color: colors.textPrimary }]}>
                  {en.today.loading}
                </Text>
              </View>
            </Card>
          </View>
        ) : hasError && !agenda ? (
          <View testID="today-error">
            <ErrorState
              title={en.today.errorTitle}
              message={en.today.errorMessage}
              retryLabel={en.today.retry}
              onRetry={onRetry}
            />
          </View>
        ) : isOffline && !agenda ? (
          <View testID="today-offline">
            <ErrorState
              title={en.today.offlineTitle}
              message={en.today.offlineMessage}
              retryLabel={en.today.retry}
              onRetry={onRetry}
            />
          </View>
        ) : (
          <>
            {isOffline ? (
              <View testID="today-offline-banner">
                <Card tone="warning" accessibilityLabel={en.today.offlineTitle}>
                  <Text style={[typography.subtitle, { color: colors.onWarningSurface }]}>
                    {en.today.offlineTitle}
                  </Text>
                  <Text style={[typography.bodySmall, { color: colors.onWarningSurface }]}>
                    {en.today.offlineMessage}
                  </Text>
                  {queuedCount > 0 ? (
                    <Text
                      testID="today-queued-count"
                      style={[typography.caption, { color: colors.onWarningSurface }]}
                    >
                      {`${queuedCount} ${en.today.queuedSuffix}`}
                    </Text>
                  ) : null}
                  {onRetry ? (
                    <View testID="today-offline-retry">
                      <Button
                        label={en.today.syncNow}
                        accessibilityLabel={en.today.syncNow}
                        variant="secondary"
                        onPress={onRetry}
                      />
                    </View>
                  ) : null}
                </Card>
              </View>
            ) : null}

            {notice ? (
              <View testID={`today-notice-${notice}`}>
                <Card tone="warning" accessibilityLabel={en.today[`${notice}Title`]}>
                  <Text style={[typography.subtitle, { color: colors.onWarningSurface }]}>
                    {en.today[`${notice}Title`]}
                  </Text>
                  <Text style={[typography.bodySmall, { color: colors.onWarningSurface }]}>
                    {en.today[`${notice}Message`]}
                  </Text>
                </Card>
              </View>
            ) : null}

            {!agenda || agenda.isEmpty ? (
              <View testID="today-empty-state">
                <EmptyState title={en.today.emptyTitle} message={en.today.emptyMessage} />
              </View>
            ) : (
              <View style={{ gap: spacing.md }}>
                <View testID="today-doses-section" style={{ gap: spacing.sm }}>
                  <Text
                    accessibilityRole="header"
                    style={[typography.subtitle, { color: colors.textPrimary }]}
                  >
                    {en.today.dosesHeading}
                  </Text>

                  {agenda.doseGroups.length === 0 ? (
                    <Text
                      testID="today-no-doses"
                      style={[typography.bodySmall, { color: colors.textSecondary }]}
                    >
                      {en.today.noDosesToday}
                    </Text>
                  ) : (
                    agenda.doseGroups.map((group) => (
                      <View
                        key={group.time}
                        testID={`today-dose-group-${group.time}`}
                        style={{ gap: spacing.xs }}
                      >
                        <Text
                          testID={`today-dose-time-${group.time}`}
                          style={[typography.label, { color: colors.textSecondary }]}
                        >
                          {group.time}
                        </Text>

                        {group.doses.map((dose) => {
                          const title = dose.strength
                            ? `${dose.medicationName} (${dose.strength})`
                            : dose.medicationName;
                          const detailParts = [dose.doseText, dose.instructions].filter(
                            (part): part is string => Boolean(part && part.trim().length > 0),
                          );
                          const subtitle = detailParts.join(' · ');

                          return (
                            <View key={dose.id} testID={`today-dose-row-${dose.id}`}>
                              <Card accessibilityLabel={`${title}, ${group.time}`}>
                                <View style={styles.rowBetween}>
                                  <View style={styles.flex}>
                                    <Text style={[typography.body, { color: colors.textPrimary }]}>
                                      {title}
                                    </Text>
                                    {subtitle ? (
                                      <Text
                                        style={[
                                          typography.caption,
                                          { color: colors.textSecondary },
                                        ]}
                                      >
                                        {subtitle}
                                      </Text>
                                    ) : null}
                                  </View>
                                  <View testID={`today-dose-status-${dose.id}`}>
                                    <Chip
                                      label={doseStatusLabel(dose.status)}
                                      tone={doseStatusTone(dose.status)}
                                    />
                                  </View>
                                </View>

                                {canEditDoses && dose.status === 'pending' ? (
                                  <View
                                    style={[
                                      styles.actionsRow,
                                      { gap: spacing.sm, marginTop: spacing.xs },
                                    ]}
                                  >
                                    <View
                                      testID={`today-dose-given-${dose.id}`}
                                      style={styles.flex}
                                    >
                                      <Button
                                        label={en.today.markGiven}
                                        accessibilityLabel={`${en.today.markGiven}: ${dose.medicationName} ${group.time}`}
                                        variant="primary"
                                        onPress={() => onCheckOffDose?.(dose.id, 'given')}
                                      />
                                    </View>
                                    <View testID={`today-dose-skip-${dose.id}`} style={styles.flex}>
                                      <Button
                                        label={en.today.markSkipped}
                                        accessibilityLabel={`${en.today.markSkipped}: ${dose.medicationName} ${group.time}`}
                                        variant="secondary"
                                        onPress={() => onCheckOffDose?.(dose.id, 'skipped')}
                                      />
                                    </View>
                                  </View>
                                ) : null}
                              </Card>
                            </View>
                          );
                        })}
                      </View>
                    ))
                  )}
                </View>

                <View testID="today-appointment-section" style={{ gap: spacing.xs }}>
                  <Text
                    accessibilityRole="header"
                    style={[typography.subtitle, { color: colors.textPrimary }]}
                  >
                    {en.today.nextAppointmentHeading}
                  </Text>

                  {agenda.nextAppointment ? (
                    <View testID="today-next-appointment">
                      <ListRow
                        title={agenda.nextAppointment.title}
                        subtitle={
                          [
                            formatLocalDateInZone(agenda.nextAppointment.startsAt, agenda.timezone),
                            agenda.nextAppointment.location,
                          ]
                            .filter(Boolean)
                            .join(' · ') || undefined
                        }
                        rightText={formatLocalTimeInZone(
                          agenda.nextAppointment.startsAt,
                          agenda.timezone,
                        )}
                        onPress={
                          onOpenAppointment
                            ? () => onOpenAppointment(agenda.nextAppointment!.id)
                            : undefined
                        }
                      />
                    </View>
                  ) : (
                    <Text
                      testID="today-no-appointment"
                      style={[typography.bodySmall, { color: colors.textSecondary }]}
                    >
                      {en.today.noUpcomingAppointment}
                    </Text>
                  )}
                </View>

                <View testID="today-tasks-section" style={{ gap: spacing.xs }}>
                  <Text
                    accessibilityRole="header"
                    style={[typography.subtitle, { color: colors.textPrimary }]}
                  >
                    {en.today.tasksHeading}
                  </Text>

                  {agenda.tasksDueToday.length > 0 ? (
                    agenda.tasksDueToday.map((task) => (
                      <View key={task.id} testID={`today-task-row-${task.id}`}>
                        <ListRow
                          title={task.title}
                          rightText={
                            task.dueAt
                              ? formatLocalTimeInZone(task.dueAt, agenda.timezone)
                              : undefined
                          }
                          onPress={onOpenTask ? () => onOpenTask(task.id) : undefined}
                        />
                      </View>
                    ))
                  ) : (
                    <Text
                      testID="today-no-tasks"
                      style={[typography.bodySmall, { color: colors.textSecondary }]}
                    >
                      {en.today.noTasksToday}
                    </Text>
                  )}
                </View>
              </View>
            )}
          </>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  flex: {
    flex: 1,
  },
});
