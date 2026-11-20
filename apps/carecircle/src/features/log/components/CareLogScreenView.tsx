import type { LogType } from '@carecircle/core';
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
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import en from '../../../../i18n/en.json';
import {
  ALL_LOG_TYPES,
  formatCareLogTimestamp,
  type CareLogEntryItem,
  type CareLogMemberOption,
} from '../api';

export interface CareLogScreenViewProps {
  circleName: string;
  timezone: string;
  members: ReadonlyArray<CareLogMemberOption>;
  entries: ReadonlyArray<CareLogEntryItem>;
  selectedType: LogType | null;
  selectedPersonId: string | null;
  onSelectType: (type: LogType | null) => void;
  onSelectPerson: (userId: string | null) => void;
  hasMore: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  hasError: boolean;
  isOffline?: boolean;
  onRetry: () => void;
  onLoadMore: () => void;
  exportFrom: string;
  exportTo: string;
  onChangeExportFrom: (val: string) => void;
  onChangeExportTo: (val: string) => void;
  onPressExportPdf: () => void;
  isExporting: boolean;
  exportError: string | null;
}

export function logTypeLabelFor(type: LogType): string {
  switch (type) {
    case 'dose':
      return en.careLog.typeDose;
    case 'med_change':
      return en.careLog.typeMedChange;
    case 'appointment':
      return en.careLog.typeAppointment;
    case 'task':
      return en.careLog.typeTask;
    case 'visit_note':
      return en.careLog.typeVisitNote;
    case 'member':
      return en.careLog.typeMember;
  }
}

export function CareLogScreenView({
  circleName,
  timezone,
  members,
  entries,
  selectedType,
  selectedPersonId,
  onSelectType,
  onSelectPerson,
  hasMore,
  isLoading,
  isLoadingMore,
  hasError,
  isOffline = false,
  onRetry,
  onLoadMore,
  exportFrom,
  exportTo,
  onChangeExportFrom,
  onChangeExportTo,
  onPressExportPdf,
  isExporting,
  exportError,
}: CareLogScreenViewProps) {
  const { colors, radii, spacing, typography } = useTheme();

  return (
    <ScrollView
      testID="care-log-screen"
      style={[styles.screen, { backgroundColor: colors.background }]}
      contentContainerStyle={[
        styles.content,
        {
          padding: spacing.lg,
          gap: spacing.md,
        },
      ]}
    >
      <Header title={en.careLog.title} subtitle={circleName || en.careLog.subtitle} />

      {isLoading ? (
        <View testID="care-log-loading" style={[styles.statusRow, { gap: spacing.sm }]}>
          <ActivityIndicator color={colors.primary} />
          <Text
            style={{
              color: colors.textPrimary,
              fontSize: typography.body.fontSize,
              lineHeight: typography.body.lineHeight,
            }}
          >
            {en.careLog.loading}
          </Text>
        </View>
      ) : null}

      {isOffline && !isLoading ? (
        <View testID="care-log-offline">
          <ErrorState
            title={en.careLog.offlineTitle}
            message={en.careLog.offlineMessage}
            retryLabel={en.careLog.retry}
            onRetry={onRetry}
          />
        </View>
      ) : null}

      {hasError && !isOffline && !isLoading ? (
        <View testID="care-log-error">
          <ErrorState
            title={en.careLog.errorTitle}
            message={en.careLog.errorMessage}
            retryLabel={en.careLog.retry}
            onRetry={onRetry}
          />
        </View>
      ) : null}

      {!isLoading && !hasError && !isOffline ? (
        <>
          <Card>
            <View style={{ gap: spacing.sm }}>
              <Text
                style={{
                  color: colors.textPrimary,
                  fontSize: typography.subtitle.fontSize,
                  lineHeight: typography.subtitle.lineHeight,
                  fontWeight: typography.subtitle.fontWeight,
                }}
              >
                {en.careLog.exportHeading}
              </Text>

              <View style={[styles.dateRangeRow, { gap: spacing.sm }]}>
                <View style={styles.dateField}>
                  <Text
                    style={{
                      color: colors.textSecondary,
                      fontSize: typography.caption.fontSize,
                      lineHeight: typography.caption.lineHeight,
                    }}
                  >
                    {en.careLog.exportFromLabel}
                  </Text>
                  <TextInput
                    testID="care-log-export-from-input"
                    accessibilityLabel={en.careLog.exportFromLabel}
                    value={exportFrom}
                    onChangeText={onChangeExportFrom}
                    autoCapitalize="none"
                    style={[
                      styles.input,
                      {
                        borderColor: colors.border,
                        borderRadius: radii.md,
                        color: colors.textPrimary,
                        paddingHorizontal: spacing.sm,
                        paddingVertical: spacing.xs,
                      },
                    ]}
                  />
                </View>

                <View style={styles.dateField}>
                  <Text
                    style={{
                      color: colors.textSecondary,
                      fontSize: typography.caption.fontSize,
                      lineHeight: typography.caption.lineHeight,
                    }}
                  >
                    {en.careLog.exportToLabel}
                  </Text>
                  <TextInput
                    testID="care-log-export-to-input"
                    accessibilityLabel={en.careLog.exportToLabel}
                    value={exportTo}
                    onChangeText={onChangeExportTo}
                    autoCapitalize="none"
                    style={[
                      styles.input,
                      {
                        borderColor: colors.border,
                        borderRadius: radii.md,
                        color: colors.textPrimary,
                        paddingHorizontal: spacing.sm,
                        paddingVertical: spacing.xs,
                      },
                    ]}
                  />
                </View>
              </View>

              {exportError ? (
                <Text
                  testID="care-log-export-error"
                  style={{
                    color: colors.danger,
                    fontSize: typography.caption.fontSize,
                    lineHeight: typography.caption.lineHeight,
                  }}
                >
                  {exportError}
                </Text>
              ) : null}

              <View testID="care-log-export-button">
                <Button
                  label={isExporting ? en.careLog.exportingButton : en.careLog.exportButton}
                  accessibilityLabel={en.careLog.exportButton}
                  disabled={isExporting}
                  onPress={onPressExportPdf}
                />
              </View>
            </View>
          </Card>

          <Card>
            <View style={{ gap: spacing.sm }}>
              <Text
                style={{
                  color: colors.textPrimary,
                  fontSize: typography.subtitle.fontSize,
                  lineHeight: typography.subtitle.lineHeight,
                  fontWeight: typography.subtitle.fontWeight,
                }}
              >
                {en.careLog.filterTypeHeading}
              </Text>
              <View style={[styles.chipRow, { gap: spacing.xs }]}>
                <View testID="care-log-filter-type-all">
                  <Chip
                    label={en.careLog.filterAllTypes}
                    accessibilityLabel={`${en.careLog.filterTypeHeading}: ${en.careLog.filterAllTypes}`}
                    selected={selectedType === null}
                    onPress={() => onSelectType(null)}
                  />
                </View>
                {ALL_LOG_TYPES.map((type) => (
                  <View key={type} testID={`care-log-filter-type-${type}`}>
                    <Chip
                      label={logTypeLabelFor(type)}
                      accessibilityLabel={`${en.careLog.filterTypeHeading}: ${logTypeLabelFor(type)}`}
                      selected={selectedType === type}
                      onPress={() => onSelectType(type)}
                    />
                  </View>
                ))}
              </View>

              <Text
                style={{
                  color: colors.textPrimary,
                  fontSize: typography.subtitle.fontSize,
                  lineHeight: typography.subtitle.lineHeight,
                  fontWeight: typography.subtitle.fontWeight,
                }}
              >
                {en.careLog.filterPersonHeading}
              </Text>
              <View style={[styles.chipRow, { gap: spacing.xs }]}>
                <View testID="care-log-filter-person-all">
                  <Chip
                    label={en.careLog.filterAllPeople}
                    accessibilityLabel={`${en.careLog.filterPersonHeading}: ${en.careLog.filterAllPeople}`}
                    selected={selectedPersonId === null}
                    onPress={() => onSelectPerson(null)}
                  />
                </View>
                {members.map((member) => (
                  <View key={member.userId} testID={`care-log-filter-person-${member.userId}`}>
                    <Chip
                      label={member.displayName}
                      accessibilityLabel={`${en.careLog.filterPersonHeading}: ${member.displayName}`}
                      selected={selectedPersonId === member.userId}
                      onPress={() => onSelectPerson(member.userId)}
                    />
                  </View>
                ))}
              </View>
            </View>
          </Card>

          {entries.length === 0 ? (
            <View testID="care-log-empty">
              <EmptyState title={en.careLog.emptyTitle} message={en.careLog.emptyMessage} />
            </View>
          ) : (
            <View testID="care-log-entry-list" style={{ gap: spacing.sm }}>
              {entries.map((entry) => (
                <Card key={entry.id}>
                  <View testID={`care-log-entry-${entry.id}`} style={{ gap: spacing.xs }}>
                    <View style={styles.entryHeader}>
                      <Text
                        style={{
                          color: colors.primary,
                          fontSize: typography.caption.fontSize,
                          lineHeight: typography.caption.lineHeight,
                          fontWeight: typography.subtitle.fontWeight,
                        }}
                      >
                        {logTypeLabelFor(entry.type)}
                      </Text>
                      <Text
                        style={{
                          color: colors.textSecondary,
                          fontSize: typography.caption.fontSize,
                          lineHeight: typography.caption.lineHeight,
                        }}
                      >
                        {formatCareLogTimestamp(entry.createdAt, timezone)}
                      </Text>
                    </View>
                    {entry.summary ? (
                      <Text
                        style={{
                          color: colors.textPrimary,
                          fontSize: typography.body.fontSize,
                          lineHeight: typography.body.lineHeight,
                        }}
                      >
                        {entry.summary}
                      </Text>
                    ) : null}
                    <Text
                      style={{
                        color: colors.textSecondary,
                        fontSize: typography.caption.fontSize,
                        lineHeight: typography.caption.lineHeight,
                      }}
                    >
                      {entry.actorDisplayName}
                    </Text>
                  </View>
                </Card>
              ))}

              {hasMore ? (
                <View testID="care-log-load-more-button">
                  <Button
                    variant="secondary"
                    label={en.careLog.loadMore}
                    accessibilityLabel={en.careLog.loadMore}
                    disabled={isLoadingMore}
                    onPress={onLoadMore}
                  />
                </View>
              ) : null}
            </View>
          )}
        </>
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
  dateRangeRow: {
    flexDirection: 'row',
  },
  dateField: {
    flex: 1,
    gap: 4,
  },
  input: {
    borderWidth: 1,
    minHeight: MIN_TOUCH_TARGET_PT,
    minWidth: MIN_TOUCH_TARGET_PT,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  entryHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
});
