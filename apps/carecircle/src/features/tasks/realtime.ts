import { taskRowSchema, type Task } from '@carecircle/core';
import { getSupabaseClient } from '../auth/api';
import type { PostgresChangesPayload, RealtimeSupabaseClientLike } from '../today/realtime';
import { requestTodayReload } from '../today/refresh';

export interface SubscribeToCircleTasksOptions {
  circleId: string;
  getClient?: () => RealtimeSupabaseClientLike;
  onTaskUpsert?: (task: Task) => void;
  onTaskDelete?: (taskId: string) => void;
}

function normalizeIsoTimestamp(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

export function parseRealtimeTaskRow(rawRow: unknown): Task | null {
  if (!rawRow || typeof rawRow !== 'object' || Array.isArray(rawRow)) {
    return null;
  }
  const rec = rawRow as Record<string, unknown>;
  const normalized = {
    ...rec,
    due_at:
      rec.due_at === null || rec.due_at === undefined ? null : normalizeIsoTimestamp(rec.due_at),
    done_at:
      rec.done_at === null || rec.done_at === undefined ? null : normalizeIsoTimestamp(rec.done_at),
    assignee: rec.assignee ?? null,
    done_by: rec.done_by ?? null,
    source: rec.source === 'visit_note' ? 'visit_note' : 'manual',
  };
  const parsed = taskRowSchema.safeParse(normalized);
  if (!parsed.success) {
    return null;
  }
  return {
    id: parsed.data.id,
    circleId: parsed.data.circle_id,
    title: parsed.data.title,
    dueAt: parsed.data.due_at,
    assignee: parsed.data.assignee,
    doneAt: parsed.data.done_at,
    doneBy: parsed.data.done_by,
    source: parsed.data.source,
  };
}

export function subscribeToCircleTasks(options: SubscribeToCircleTasksOptions): () => void {
  const { circleId } = options;
  const getClient =
    options.getClient ?? (() => getSupabaseClient() as unknown as RealtimeSupabaseClientLike);

  let active = true;

  const handlePayload = (payload: PostgresChangesPayload): void => {
    if (!active || !payload) return;

    if (payload.eventType === 'DELETE') {
      const deletedId =
        typeof payload.old?.id === 'string'
          ? payload.old.id
          : typeof payload.new?.id === 'string'
            ? payload.new.id
            : null;
      if (!deletedId) return;
      options.onTaskDelete?.(deletedId);
      requestTodayReload();
      return;
    }

    const updated = parseRealtimeTaskRow(payload.new);
    if (!updated || updated.circleId !== circleId) {
      return;
    }

    options.onTaskUpsert?.(updated);
    requestTodayReload();
  };

  const client = getClient();
  const channel = client
    .channel(`circle-tasks:${circleId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'tasks',
        filter: `circle_id=eq.${circleId}`,
      },
      handlePayload,
    )
    .subscribe();

  return () => {
    if (!active) return;
    active = false;
    try {
      void channel.unsubscribe?.();
    } catch {
      // Ignore cleanup errors on unmount.
    }
    try {
      void client.removeChannel?.(channel);
    } catch {
      // Ignore cleanup errors on unmount.
    }
  };
}
