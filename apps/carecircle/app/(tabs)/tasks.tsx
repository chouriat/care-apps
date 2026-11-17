import type { MemberRole, Task } from '@carecircle/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { loadCareCircleMocks } from '../../src/features/mocks';
import {
  addTask,
  loadTasksScreen,
  setTaskCompletion,
  sortTasks,
  subscribeToCircleTasks,
  TasksScreenView,
  updateTask,
  type TaskFormDraft,
  type TasksDeps,
  type TasksMemberOption,
} from '../../src/features/tasks';
import type { RealtimeSupabaseClientLike } from '../../src/features/today/realtime';

const EMPTY_CIRCLE_ID = '00000000-0000-4000-8000-000000000000';

export interface TasksRouteProps {
  deps?: TasksDeps;
}

export default function TasksScreen({ deps }: TasksRouteProps = {}) {
  const depsRef = useRef<TasksDeps | undefined>(deps);
  depsRef.current = deps;
  const mocks = loadCareCircleMocks(deps?.env);

  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [isOffline, setIsOffline] = useState(Boolean(deps?.isOffline));
  const [notSavedNotice, setNotSavedNotice] = useState(false);
  const [circleId, setCircleId] = useState('');
  const [circleTitle, setCircleTitle] = useState<string | undefined>(undefined);
  const [circleTimezone, setCircleTimezone] = useState('UTC');
  const [currentUserId, setCurrentUserId] = useState('');
  const [memberRole, setMemberRole] = useState<MemberRole>('viewer');
  const [members, setMembers] = useState<TasksMemberOption[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);

  const reload = useCallback(async () => {
    setIsLoading(true);
    setHasError(false);
    const res = await loadTasksScreen(depsRef.current);
    if (res.ok) {
      setCircleId(res.circle.id);
      setCircleTitle(
        res.circle.careRecipientName
          ? `${res.circle.name} · ${res.circle.careRecipientName}`
          : res.circle.name,
      );
      setCircleTimezone(res.circle.timezone);
      setCurrentUserId(res.currentUserId);
      setMemberRole(res.memberRole);
      setMembers(res.members);
      setTasks(res.tasks);
      setIsOffline(res.isOffline);
      setHasError(false);
    } else {
      setIsOffline(res.isOffline);
      setHasError(!res.isOffline);
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const refreshList = useCallback(async () => {
    const res = await loadTasksScreen(depsRef.current);
    if (res.ok) {
      setTasks(res.tasks);
      setMembers(res.members);
      setCurrentUserId(res.currentUserId);
      setMemberRole(res.memberRole);
      setIsOffline(res.isOffline);
      setHasError(false);
    } else {
      setIsOffline(res.isOffline);
      setHasError(!res.isOffline);
    }
  }, []);

  useEffect(() => {
    const activeDeps = depsRef.current;
    if (!circleId || circleId === EMPTY_CIRCLE_ID || mocks || activeDeps?.isOffline) {
      return;
    }
    if (activeDeps?.getClient) {
      const candidate = activeDeps.getClient() as unknown as Partial<RealtimeSupabaseClientLike>;
      if (typeof candidate?.channel !== 'function') {
        return;
      }
    }
    return subscribeToCircleTasks({
      circleId,
      ...(activeDeps?.getClient
        ? {
            getClient: () => activeDeps.getClient!() as unknown as RealtimeSupabaseClientLike,
          }
        : {}),
      onTaskUpsert: (updated) => {
        setTasks((prev) => {
          const exists = prev.some((t) => t.id === updated.id);
          const next = exists
            ? prev.map((t) => (t.id === updated.id ? updated : t))
            : [...prev, updated];
          return sortTasks(next);
        });
      },
      onTaskDelete: (deletedId) => {
        setTasks((prev) => prev.filter((t) => t.id !== deletedId));
      },
    });
  }, [circleId, mocks]);

  const handleSaveTask = useCallback(
    async (draft: TaskFormDraft, editingTaskId: string | null): Promise<boolean> => {
      if (!circleId) return false;
      setNotSavedNotice(false);

      const res = editingTaskId
        ? await updateTask(
            {
              circleId,
              taskId: editingTaskId,
              timezone: circleTimezone,
              ...draft,
              memberRole,
            },
            depsRef.current,
          )
        : await addTask(
            {
              circleId,
              timezone: circleTimezone,
              ...draft,
              memberRole,
            },
            depsRef.current,
          );

      if (!res.ok) {
        setIsOffline(res.isOffline);
        setNotSavedNotice(true);
        return false;
      }

      await refreshList();
      return true;
    },
    [circleId, circleTimezone, memberRole, refreshList],
  );

  const handleToggleComplete = useCallback(
    async (taskId: string, completed: boolean): Promise<boolean> => {
      if (!circleId) return false;
      setNotSavedNotice(false);

      const res = await setTaskCompletion(
        {
          circleId,
          taskId,
          completed,
          currentUserId,
          memberRole,
        },
        depsRef.current,
      );

      if (!res.ok) {
        setIsOffline(res.isOffline);
        setNotSavedNotice(true);
        return false;
      }

      await refreshList();
      return true;
    },
    [circleId, currentUserId, memberRole, refreshList],
  );

  return (
    <TasksScreenView
      circleId={circleId}
      circleTitle={circleTitle}
      circleTimezone={circleTimezone}
      currentUserId={currentUserId}
      memberRole={memberRole}
      members={members}
      tasks={tasks}
      isLoading={isLoading}
      hasError={hasError}
      isOffline={isOffline}
      notSavedNotice={notSavedNotice}
      onRetry={() => {
        void reload();
      }}
      onSaveTask={handleSaveTask}
      onToggleComplete={handleToggleComplete}
    />
  );
}
