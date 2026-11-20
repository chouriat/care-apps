import type { MemberRole, Task } from '@carecircle/core';
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
import { useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import en from '../../../../i18n/en.json';
import { formatLocalDateInZone, formatLocalTimeInZone } from '../../today/api';
import {
  filterTasksByAssignee,
  formatTaskDueInZone,
  sortTasks,
  validateTaskDraft,
  type TaskAssigneeFilter,
  type TasksMemberOption,
} from '../api';

export interface TaskFormDraft {
  title: string;
  dueDate: string;
  dueTime: string;
  assignee: string | null;
}

export interface TasksScreenViewProps {
  circleId: string;
  circleTitle?: string;
  circleTimezone: string;
  currentUserId: string;
  memberRole: MemberRole;
  members: ReadonlyArray<TasksMemberOption>;
  tasks: ReadonlyArray<Task>;
  isLoading: boolean;
  hasError: boolean;
  isOffline: boolean;
  notSavedNotice?: boolean;
  onRetry: () => void;
  onSaveTask?: (draft: TaskFormDraft, editingTaskId: string | null) => Promise<boolean>;
  onToggleComplete?: (taskId: string, completed: boolean) => Promise<boolean>;
}

function emptyDraft(): TaskFormDraft {
  return {
    title: '',
    dueDate: '',
    dueTime: '',
    assignee: null,
  };
}

function draftFromTask(task: Task, timezone: string): TaskFormDraft {
  return {
    title: task.title,
    dueDate: task.dueAt ? formatLocalDateInZone(new Date(task.dueAt), timezone) : '',
    dueTime: task.dueAt ? formatLocalTimeInZone(task.dueAt, timezone) : '',
    assignee: task.assignee,
  };
}

export function TasksScreenView({
  circleId,
  circleTitle,
  circleTimezone,
  currentUserId,
  memberRole,
  members,
  tasks,
  isLoading,
  hasError,
  isOffline,
  notSavedNotice = false,
  onRetry,
  onSaveTask,
  onToggleComplete,
}: TasksScreenViewProps) {
  const { colors, radii, spacing, typography } = useTheme();
  const canEdit = memberRole === 'owner' || memberRole === 'helper';

  const [assigneeFilter, setAssigneeFilter] = useState<TaskAssigneeFilter>('everyone');
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TaskFormDraft>(() => emptyDraft());
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const memberNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) {
      map.set(m.userId, m.displayName);
    }
    return map;
  }, [members]);

  const sortedTasks = useMemo(() => sortTasks(tasks), [tasks]);
  const filteredTasks = useMemo(
    () => filterTasksByAssignee(sortedTasks, assigneeFilter, currentUserId),
    [assigneeFilter, currentUserId, sortedTasks],
  );

  const openTasks = useMemo(() => filteredTasks.filter((t) => t.doneAt === null), [filteredTasks]);
  const doneTasks = useMemo(() => filteredTasks.filter((t) => t.doneAt !== null), [filteredTasks]);

  const handleOpenAdd = () => {
    setEditingTaskId(null);
    setDraft(emptyDraft());
    setFormError(null);
    setIsFormOpen(true);
  };

  const handleOpenEdit = (task: Task) => {
    setEditingTaskId(task.id);
    setDraft(draftFromTask(task, circleTimezone));
    setFormError(null);
    setIsFormOpen(true);
  };

  const handleCancelForm = () => {
    setIsFormOpen(false);
    setEditingTaskId(null);
    setFormError(null);
  };

  const handleSubmitForm = async () => {
    if (isSaving) return;
    setFormError(null);

    const validated = validateTaskDraft({
      circleId: circleId || '00000000-0000-4000-8000-000000000000',
      timezone: circleTimezone,
      title: draft.title,
      dueDate: draft.dueDate,
      dueTime: draft.dueTime,
      assignee: draft.assignee,
    });

    if (!validated.ok) {
      setFormError(validated.message);
      return;
    }

    if (!onSaveTask) return;
    setIsSaving(true);
    try {
      const ok = await onSaveTask(draft, editingTaskId);
      if (ok) {
        setIsFormOpen(false);
        setEditingTaskId(null);
        setFormError(null);
      }
    } finally {
      setIsSaving(false);
    }
  };

  const renderTaskCard = (task: Task) => {
    const isDone = task.doneAt !== null;
    const assigneeName = task.assignee
      ? (memberNameById.get(task.assignee) ?? en.circle.defaultMemberName)
      : null;

    return (
      <Card key={task.id}>
        <View
          testID={`task-card-${task.id}`}
          importantForAccessibility="yes"
          style={{ gap: spacing.xs }}
        >
          <View style={styles.taskHeaderRow}>
            <Text
              style={{
                color: colors.textPrimary,
                fontSize: typography.subtitle.fontSize,
                lineHeight: typography.subtitle.lineHeight,
                fontWeight: typography.subtitle.fontWeight,
                textDecorationLine: isDone ? 'line-through' : 'none',
                flex: 1,
              }}
            >
              {task.title}
            </Text>

            {task.source === 'visit_note' ? (
              <View
                testID={`task-visit-note-badge-${task.id}`}
                style={[
                  styles.badge,
                  {
                    backgroundColor: colors.surface,
                    borderColor: colors.border,
                    borderRadius: radii.sm,
                    paddingHorizontal: spacing.xs,
                    paddingVertical: 2,
                  },
                ]}
              >
                <Text
                  style={{
                    color: colors.primary,
                    fontSize: typography.caption.fontSize,
                    lineHeight: typography.caption.lineHeight,
                  }}
                >
                  {en.tasks.visitNoteBadge}
                </Text>
              </View>
            ) : null}
          </View>

          <Text
            style={{
              color: colors.textSecondary,
              fontSize: typography.caption.fontSize,
              lineHeight: typography.caption.lineHeight,
            }}
          >
            {task.dueAt
              ? en.tasks.duePrefix.replace('{due}', formatTaskDueInZone(task.dueAt, circleTimezone))
              : en.tasks.noDueDate}
          </Text>

          {assigneeName ? (
            <Text
              testID={`task-assignee-${task.id}`}
              style={{
                color: colors.textSecondary,
                fontSize: typography.caption.fontSize,
                lineHeight: typography.caption.lineHeight,
              }}
            >
              {en.tasks.assigneePrefix.replace('{name}', assigneeName)}
            </Text>
          ) : null}

          {canEdit ? (
            <View style={[styles.actionsRow, { gap: spacing.xs }]}>
              <View
                testID={
                  isDone ? `task-uncomplete-button-${task.id}` : `task-complete-button-${task.id}`
                }
              >
                <Button
                  variant={isDone ? 'secondary' : 'primary'}
                  label={isDone ? en.tasks.uncompleteCta : en.tasks.completeCta}
                  accessibilityLabel={`${isDone ? en.tasks.uncompleteCta : en.tasks.completeCta} ${task.title}`}
                  onPress={() => {
                    void onToggleComplete?.(task.id, !isDone);
                  }}
                />
              </View>
              <View testID={`task-edit-button-${task.id}`}>
                <Button
                  variant="secondary"
                  label={en.tasks.editCta}
                  accessibilityLabel={`${en.tasks.editCta} ${task.title}`}
                  onPress={() => handleOpenEdit(task)}
                />
              </View>
            </View>
          ) : null}
        </View>
      </Card>
    );
  };

  return (
    <ScrollView
      testID="tasks-screen"
      style={[styles.screen, { backgroundColor: colors.background }]}
      contentContainerStyle={[
        styles.content,
        {
          padding: spacing.lg,
          gap: spacing.md,
        },
      ]}
    >
      <Header title={en.tasks.title} subtitle={circleTitle} />

      {isLoading ? (
        <View testID="tasks-loading" style={[styles.statusRow, { gap: spacing.sm }]}>
          <ActivityIndicator color={colors.primary} />
          <Text
            style={{
              color: colors.textPrimary,
              fontSize: typography.body.fontSize,
              lineHeight: typography.body.lineHeight,
            }}
          >
            {en.tasks.loading}
          </Text>
        </View>
      ) : null}

      {isOffline ? (
        <View testID="tasks-offline-banner">
          <ErrorState
            title={en.tasks.offlineTitle}
            message={en.tasks.offlineMessage}
            retryLabel={en.tasks.retry}
            onRetry={onRetry}
          />
        </View>
      ) : null}

      {hasError && !isOffline && !isLoading ? (
        <View testID="tasks-error-state">
          <ErrorState
            title={en.tasks.errorTitle}
            message={en.tasks.errorMessage}
            retryLabel={en.tasks.retry}
            onRetry={onRetry}
          />
        </View>
      ) : null}

      {notSavedNotice ? (
        <Card>
          <View testID="tasks-not-saved-banner" style={{ gap: spacing.xs }}>
            <Text
              style={{
                color: colors.danger,
                fontSize: typography.subtitle.fontSize,
                lineHeight: typography.subtitle.lineHeight,
                fontWeight: typography.subtitle.fontWeight,
              }}
            >
              {en.tasks.notSavedTitle}
            </Text>
            <Text
              style={{
                color: colors.textSecondary,
                fontSize: typography.body.fontSize,
                lineHeight: typography.body.lineHeight,
              }}
            >
              {en.tasks.notSavedMessage}
            </Text>
          </View>
        </Card>
      ) : null}

      {!isLoading && !hasError ? (
        <>
          {canEdit && !isFormOpen ? (
            <View testID="tasks-add-button">
              <Button
                label={en.tasks.addCta}
                accessibilityLabel={en.tasks.addA11y}
                onPress={handleOpenAdd}
              />
            </View>
          ) : null}

          {canEdit && isFormOpen ? (
            <Card>
              <View testID="tasks-form" style={{ gap: spacing.sm }}>
                <Text
                  style={{
                    color: colors.textPrimary,
                    fontSize: typography.subtitle.fontSize,
                    lineHeight: typography.subtitle.lineHeight,
                    fontWeight: typography.subtitle.fontWeight,
                  }}
                >
                  {editingTaskId ? en.tasks.formEditTitle : en.tasks.formAddTitle}
                </Text>

                <View style={{ gap: 4 }}>
                  <Text
                    style={{
                      color: colors.textSecondary,
                      fontSize: typography.caption.fontSize,
                      lineHeight: typography.caption.lineHeight,
                    }}
                  >
                    {en.tasks.titleLabel}
                  </Text>
                  <TextInput
                    testID="tasks-title-input"
                    accessibilityLabel={en.tasks.titleLabel}
                    placeholder={en.tasks.titlePlaceholder}
                    value={draft.title}
                    onChangeText={(text) => setDraft((prev) => ({ ...prev, title: text }))}
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

                <View style={[styles.dateRow, { gap: spacing.sm }]}>
                  <View style={styles.dateCol}>
                    <Text
                      style={{
                        color: colors.textSecondary,
                        fontSize: typography.caption.fontSize,
                        lineHeight: typography.caption.lineHeight,
                      }}
                    >
                      {en.tasks.dueDateLabel}
                    </Text>
                    <TextInput
                      testID="tasks-due-date-input"
                      accessibilityLabel={en.tasks.dueDateLabel}
                      placeholder={en.tasks.dueDatePlaceholder}
                      value={draft.dueDate}
                      onChangeText={(text) => setDraft((prev) => ({ ...prev, dueDate: text }))}
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

                  <View style={styles.dateCol}>
                    <Text
                      style={{
                        color: colors.textSecondary,
                        fontSize: typography.caption.fontSize,
                        lineHeight: typography.caption.lineHeight,
                      }}
                    >
                      {en.tasks.dueTimeLabel}
                    </Text>
                    <TextInput
                      testID="tasks-due-time-input"
                      accessibilityLabel={en.tasks.dueTimeLabel}
                      placeholder={en.tasks.dueTimePlaceholder}
                      value={draft.dueTime}
                      onChangeText={(text) => setDraft((prev) => ({ ...prev, dueTime: text }))}
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

                <View style={{ gap: spacing.xs }}>
                  <Text
                    style={{
                      color: colors.textSecondary,
                      fontSize: typography.caption.fontSize,
                      lineHeight: typography.caption.lineHeight,
                    }}
                  >
                    {en.tasks.assigneeLabel}
                  </Text>
                  <View style={[styles.chipRow, { gap: spacing.xs }]}>
                    <View testID="tasks-assignee-option-none">
                      <Chip
                        label={en.tasks.assigneeNone}
                        accessibilityLabel={`${en.tasks.assigneeLabel}: ${en.tasks.assigneeNone}`}
                        selected={draft.assignee === null}
                        onPress={() => setDraft((prev) => ({ ...prev, assignee: null }))}
                      />
                    </View>
                    {members.map((member, idx) => (
                      <View key={member.userId} testID={`tasks-assignee-option-${member.userId}`}>
                        <View testID={`tasks-assignee-option-member-${idx}`}>
                          <Chip
                            label={member.displayName}
                            accessibilityLabel={`${en.tasks.assigneeLabel}: ${member.displayName}`}
                            selected={draft.assignee === member.userId}
                            onPress={() =>
                              setDraft((prev) => ({ ...prev, assignee: member.userId }))
                            }
                          />
                        </View>
                      </View>
                    ))}
                  </View>
                </View>

                {formError ? (
                  <Text
                    testID="tasks-form-error"
                    style={{
                      color: colors.danger,
                      fontSize: typography.caption.fontSize,
                      lineHeight: typography.caption.lineHeight,
                    }}
                  >
                    {formError}
                  </Text>
                ) : null}

                <View style={[styles.actionsRow, { gap: spacing.sm }]}>
                  <View testID="tasks-save-button" style={{ flex: 1 }}>
                    <Button
                      label={en.tasks.saveCta}
                      accessibilityLabel={en.tasks.saveCta}
                      disabled={isSaving}
                      onPress={() => {
                        void handleSubmitForm();
                      }}
                    />
                  </View>
                  <View testID="tasks-cancel-button" style={{ flex: 1 }}>
                    <Button
                      variant="secondary"
                      label={en.tasks.cancelCta}
                      accessibilityLabel={en.tasks.cancelCta}
                      disabled={isSaving}
                      onPress={handleCancelForm}
                    />
                  </View>
                </View>
              </View>
            </Card>
          ) : null}

          <Card>
            <View style={{ gap: spacing.xs }}>
              <Text
                style={{
                  color: colors.textPrimary,
                  fontSize: typography.subtitle.fontSize,
                  lineHeight: typography.subtitle.lineHeight,
                  fontWeight: typography.subtitle.fontWeight,
                }}
              >
                {en.tasks.filterHeading}
              </Text>
              <View style={[styles.chipRow, { gap: spacing.xs }]}>
                <View testID="tasks-filter-everyone">
                  <Chip
                    label={en.tasks.filterEveryone}
                    accessibilityLabel={`${en.tasks.filterHeading}: ${en.tasks.filterEveryone}`}
                    selected={assigneeFilter === 'everyone'}
                    onPress={() => setAssigneeFilter('everyone')}
                  />
                </View>
                <View testID="tasks-filter-me">
                  <Chip
                    label={en.tasks.filterMe}
                    accessibilityLabel={`${en.tasks.filterHeading}: ${en.tasks.filterMe}`}
                    selected={assigneeFilter === 'me'}
                    onPress={() => setAssigneeFilter('me')}
                  />
                </View>
                {members.map((member) => (
                  <View key={member.userId} testID={`tasks-filter-person-${member.userId}`}>
                    <Chip
                      label={member.displayName}
                      accessibilityLabel={`${en.tasks.filterHeading}: ${member.displayName}`}
                      selected={assigneeFilter === member.userId}
                      onPress={() => setAssigneeFilter(member.userId)}
                    />
                  </View>
                ))}
                <View testID="tasks-filter-nobody">
                  <Chip
                    label={en.tasks.filterNobody}
                    accessibilityLabel={`${en.tasks.filterHeading}: ${en.tasks.filterNobody}`}
                    selected={assigneeFilter === 'nobody'}
                    onPress={() => setAssigneeFilter('nobody')}
                  />
                </View>
              </View>
            </View>
          </Card>

          {openTasks.length === 0 && doneTasks.length === 0 ? (
            <View testID="tasks-empty-state">
              <EmptyState title={en.tasks.emptyTitle} message={en.tasks.emptyMessage} />
            </View>
          ) : (
            <View style={{ gap: spacing.md }}>
              {openTasks.length > 0 ? (
                <View
                  testID="tasks-open-section"
                  importantForAccessibility="yes"
                  style={{ gap: spacing.sm }}
                >
                  <Text
                    style={{
                      color: colors.textPrimary,
                      fontSize: typography.subtitle.fontSize,
                      lineHeight: typography.subtitle.lineHeight,
                      fontWeight: typography.subtitle.fontWeight,
                    }}
                  >
                    {en.tasks.openHeading}
                  </Text>
                  {openTasks.map(renderTaskCard)}
                </View>
              ) : null}

              {doneTasks.length > 0 ? (
                <View
                  testID="tasks-done-section"
                  importantForAccessibility="yes"
                  style={{ gap: spacing.sm }}
                >
                  <Text
                    style={{
                      color: colors.textPrimary,
                      fontSize: typography.subtitle.fontSize,
                      lineHeight: typography.subtitle.lineHeight,
                      fontWeight: typography.subtitle.fontWeight,
                    }}
                  >
                    {en.tasks.doneHeading}
                  </Text>
                  {doneTasks.map(renderTaskCard)}
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
  dateRow: {
    flexDirection: 'row',
  },
  dateCol: {
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
  taskHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  badge: {
    borderWidth: 1,
  },
  actionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
});
