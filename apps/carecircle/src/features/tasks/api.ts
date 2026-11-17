import {
  circleMemberRowSchema,
  circleRowSchema,
  computeUtcTriggerForLocalTime,
  taskRowSchema,
  type Circle,
  type CircleRow,
  type MemberRole,
  type Task,
  type TaskRow,
} from '@carecircle/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import en from '../../../i18n/en.json';
import { getSupabaseClient } from '../auth/api';
import { fetchSignedInMemberRole } from '../circle/api';
import { loadCareCircleMocks } from '../mocks';
import {
  DEFAULT_MOCK_NOW_ISO,
  formatLocalDateInZone,
  formatLocalTimeInZone,
  getOrInitMockTodaySnapshot,
  loadTodaySnapshot,
  type TodayDeps,
} from '../today/api';
import { requestTodayReload } from '../today/refresh';

export interface TasksMemberOption {
  userId: string;
  role: MemberRole;
  displayName: string;
}

export type TaskAssigneeFilter = 'everyone' | 'me' | 'nobody' | (string & {});

export type TasksErrorCode =
  | 'VALIDATION_ERROR'
  | 'FORBIDDEN_ROLE'
  | 'NETWORK_ERROR'
  | 'LOAD_TASKS_FAILED'
  | 'SAVE_TASK_FAILED';

export interface TasksDeps extends TodayDeps {
  getClient?: () => Pick<SupabaseClient, 'from' | 'rpc'>;
}

export interface TaskDraftInput {
  circleId: string;
  timezone: string;
  title: string;
  dueDate?: string | null;
  dueTime?: string | null;
  assignee?: string | null;
}

export interface ValidatedTaskPayload {
  circleId: string;
  title: string;
  dueAt: string | null;
  assignee: string | null;
}

export function validateTaskDraft(
  input: TaskDraftInput,
):
  | { ok: true; payload: ValidatedTaskPayload }
  | { ok: false; errorCode: 'VALIDATION_ERROR'; message: string } {
  const title = input.title.trim();
  const rawDate = input.dueDate?.trim() ?? '';
  const rawTime = input.dueTime?.trim() ?? '';

  if (!input.circleId.trim() || !title) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      message: en.tasks.validationError,
    };
  }

  let dueAt: string | null = null;
  if (rawDate.length > 0 || rawTime.length > 0) {
    if (!rawDate) {
      return {
        ok: false,
        errorCode: 'VALIDATION_ERROR',
        message: en.tasks.validationError,
      };
    }
    const effectiveTime = rawTime || '09:00';
    try {
      const trigger = computeUtcTriggerForLocalTime({
        date: rawDate,
        time: effectiveTime,
        timeZone: input.timezone,
      });
      dueAt = trigger.triggerAtIso;
    } catch {
      return {
        ok: false,
        errorCode: 'VALIDATION_ERROR',
        message: en.tasks.validationError,
      };
    }
  }

  const assignee = input.assignee?.trim() ? input.assignee.trim() : null;

  return {
    ok: true,
    payload: {
      circleId: input.circleId.trim(),
      title,
      dueAt,
      assignee,
    },
  };
}

export function sortTasks(tasks: ReadonlyArray<Task>): Task[] {
  return [...tasks].sort((a, b) => {
    const aDone = a.doneAt !== null;
    const bDone = b.doneAt !== null;
    if (aDone !== bDone) {
      return aDone ? 1 : -1;
    }
    if (!aDone) {
      // Open tasks: by due date ascending, no due date last
      if (a.dueAt === null && b.dueAt === null) {
        return a.id.localeCompare(b.id);
      }
      if (a.dueAt === null) return 1;
      if (b.dueAt === null) return -1;
      const diff = new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
      return diff !== 0 ? diff : a.id.localeCompare(b.id);
    }
    // Done tasks: newest completion first, fallback to due date
    const aDoneMs = a.doneAt ? new Date(a.doneAt).getTime() : 0;
    const bDoneMs = b.doneAt ? new Date(b.doneAt).getTime() : 0;
    if (aDoneMs !== bDoneMs) {
      return bDoneMs - aDoneMs;
    }
    return a.id.localeCompare(b.id);
  });
}

export function filterTasksByAssignee(
  tasks: ReadonlyArray<Task>,
  filter: TaskAssigneeFilter,
  currentUserId: string,
): Task[] {
  if (filter === 'everyone') {
    return [...tasks];
  }
  if (filter === 'me') {
    return tasks.filter((t) => t.assignee === currentUserId);
  }
  if (filter === 'nobody') {
    return tasks.filter((t) => t.assignee === null);
  }
  return tasks.filter((t) => t.assignee === filter);
}

export function formatTaskDueInZone(dueAtIso: string | null, timeZone: string): string {
  if (!dueAtIso) {
    return en.tasks.noDueDate;
  }
  const datePart = formatLocalDateInZone(new Date(dueAtIso), timeZone);
  const timePart = formatLocalTimeInZone(dueAtIso, timeZone);
  return `${datePart} · ${timePart}`;
}

function normalizeIsoTimestamp(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function circleFromRow(row: CircleRow): Circle {
  return {
    id: row.id,
    name: row.name,
    careRecipientName: row.care_recipient_name,
    careRecipientDob: row.care_recipient_dob,
    timezone: row.timezone,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export function taskFromRow(row: TaskRow): Task {
  return {
    id: row.id,
    circleId: row.circle_id,
    title: row.title,
    dueAt: row.due_at,
    assignee: row.assignee,
    doneAt: row.done_at,
    doneBy: row.done_by,
    source: row.source,
  };
}

function parseTaskRow(raw: unknown): Task {
  const rec = { ...(raw as Record<string, unknown>) };
  rec.due_at =
    rec.due_at === null || rec.due_at === undefined ? null : normalizeIsoTimestamp(rec.due_at);
  rec.done_at =
    rec.done_at === null || rec.done_at === undefined ? null : normalizeIsoTimestamp(rec.done_at);
  rec.assignee = rec.assignee ?? null;
  rec.done_by = rec.done_by ?? null;
  rec.source = rec.source === 'visit_note' ? 'visit_note' : 'manual';
  return taskFromRow(taskRowSchema.parse(rec));
}

function isNetworkFailureMessage(message: string, code?: string): boolean {
  if (code === 'NETWORK_ERROR') return true;
  return /network|fetch failed|failed to fetch|offline|load failed/i.test(message);
}

async function resolveUserId(deps: TasksDeps): Promise<string | null> {
  try {
    if (deps.getUserId) return await deps.getUserId();
    const { data } = await getSupabaseClient().auth.getSession();
    return data.session?.user.id ?? null;
  } catch {
    return null;
  }
}

async function refreshTodayAfterSave(deps: TasksDeps): Promise<void> {
  try {
    await loadTodaySnapshot(deps);
  } catch {
    // Today reloads on its next open or retry.
  }
  requestTodayReload();
}

export type LoadTasksResult =
  | {
      ok: true;
      circle: Circle;
      currentUserId: string;
      memberRole: MemberRole;
      members: TasksMemberOption[];
      tasks: Task[];
      isOffline: boolean;
    }
  | {
      ok: false;
      errorCode: 'NETWORK_ERROR' | 'LOAD_TASKS_FAILED';
      isOffline: boolean;
    };

export async function loadTasksScreen(deps: TasksDeps = {}): Promise<LoadTasksResult> {
  const mocks = loadCareCircleMocks(deps.env);
  if (mocks) {
    const snapshot = getOrInitMockTodaySnapshot(mocks);
    const ownerId = snapshot.circle.createdBy ?? 'c1000001-0000-4000-8000-00000000000a';
    const sorted = sortTasks(snapshot.tasks);
    return {
      ok: true,
      circle: snapshot.circle,
      currentUserId: ownerId,
      memberRole: 'owner',
      members: [
        {
          userId: ownerId,
          role: 'owner',
          displayName: en.circle.defaultMemberName,
        },
      ],
      tasks: sorted,
      isOffline: Boolean(deps.isOffline),
    };
  }

  if (deps.isOffline) {
    return {
      ok: false,
      errorCode: 'NETWORK_ERROR',
      isOffline: true,
    };
  }

  const getClient = deps.getClient ?? getSupabaseClient;

  try {
    const client = getClient();
    const userId = await resolveUserId(deps);

    const circlesRes = await client
      .from('circles')
      .select('*')
      .order('created_at', { ascending: true })
      .limit(1);

    if (circlesRes.error) {
      throw new Error(circlesRes.error.message);
    }

    const circleRows = Array.isArray(circlesRes.data) ? circlesRes.data : [];
    if (circleRows.length === 0) {
      return {
        ok: true,
        circle: {
          id: '00000000-0000-4000-8000-000000000000',
          name: en.tasks.title,
          careRecipientName: '',
          careRecipientDob: null,
          timezone: 'UTC',
          createdBy: null,
          createdAt: DEFAULT_MOCK_NOW_ISO,
        },
        currentUserId: userId ?? '',
        memberRole: 'viewer',
        members: [],
        tasks: [],
        isOffline: false,
      };
    }

    const rawCircle = { ...(circleRows[0] as Record<string, unknown>) };
    rawCircle.created_at = normalizeIsoTimestamp(rawCircle.created_at);
    const circle = circleFromRow(circleRowSchema.parse(rawCircle));

    const [roleRes, membersRes, profilesRes, tasksRes] = await Promise.all([
      fetchSignedInMemberRole(client, circle.id, userId),
      client
        .from('circle_members')
        .select('*')
        .eq('circle_id', circle.id)
        .order('joined_at', { ascending: true }),
      client.from('users_profile').select('user_id, display_name'),
      client
        .from('tasks')
        .select('*')
        .eq('circle_id', circle.id)
        .order('due_at', { ascending: true }),
    ]);

    if (roleRes.error) {
      throw new Error(roleRes.error.message);
    }
    if (membersRes.error) {
      throw new Error(membersRes.error.message);
    }
    if (tasksRes.error) {
      throw new Error(tasksRes.error.message);
    }

    const nameByUserId = new Map<string, string>();
    if (!profilesRes.error && Array.isArray(profilesRes.data)) {
      for (const row of profilesRes.data) {
        const rec = row as { user_id?: unknown; display_name?: unknown };
        if (typeof rec.user_id === 'string' && typeof rec.display_name === 'string') {
          const trimmed = rec.display_name.trim();
          if (trimmed) {
            nameByUserId.set(rec.user_id, trimmed);
          }
        }
      }
    }

    const memberRows = Array.isArray(membersRes.data) ? membersRes.data : [];
    const members: TasksMemberOption[] = memberRows.map((raw) => {
      const normalized = { ...(raw as Record<string, unknown>) };
      normalized.joined_at = normalizeIsoTimestamp(normalized.joined_at);
      const parsed = circleMemberRowSchema.parse(normalized);
      return {
        userId: parsed.user_id,
        role: parsed.role,
        displayName:
          nameByUserId.get(parsed.user_id) ??
          `${en.circle.defaultMemberName} (${parsed.user_id.slice(0, 6)})`,
      };
    });

    const rawTasks = Array.isArray(tasksRes.data) ? tasksRes.data : [];
    const tasks = sortTasks(rawTasks.map(parseTaskRow));

    return {
      ok: true,
      circle,
      currentUserId: userId ?? '',
      memberRole: roleRes.role,
      members,
      tasks,
      isOffline: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const offline = isNetworkFailureMessage(message);
    return {
      ok: false,
      errorCode: offline ? 'NETWORK_ERROR' : 'LOAD_TASKS_FAILED',
      isOffline: offline,
    };
  }
}

export type SaveTaskResult =
  | {
      ok: true;
      task: Task;
    }
  | {
      ok: false;
      errorCode: TasksErrorCode;
      isOffline: boolean;
    };

export async function addTask(
  input: TaskDraftInput & { memberRole?: MemberRole },
  deps: TasksDeps = {},
): Promise<SaveTaskResult> {
  if (input.memberRole === 'viewer') {
    return { ok: false, errorCode: 'FORBIDDEN_ROLE', isOffline: false };
  }

  const validated = validateTaskDraft(input);
  if (!validated.ok) {
    return { ok: false, errorCode: validated.errorCode, isOffline: false };
  }

  if (deps.isOffline) {
    return { ok: false, errorCode: 'NETWORK_ERROR', isOffline: true };
  }

  const mocks = loadCareCircleMocks(deps.env);
  if (mocks) {
    const snapshot = getOrInitMockTodaySnapshot(mocks);
    const created: Task = {
      id: `c1500099-0000-4000-8000-${String(snapshot.tasks.length + 1).padStart(12, '0')}`,
      circleId: validated.payload.circleId,
      title: validated.payload.title,
      dueAt: validated.payload.dueAt,
      assignee: validated.payload.assignee,
      doneAt: null,
      doneBy: null,
      source: 'manual',
    };
    snapshot.tasks.push(created);
    await refreshTodayAfterSave(deps);
    return { ok: true, task: created };
  }

  const getClient = deps.getClient ?? getSupabaseClient;
  let created: Task;

  try {
    const client = getClient();
    const res = await client
      .from('tasks')
      .insert({
        circle_id: validated.payload.circleId,
        title: validated.payload.title,
        due_at: validated.payload.dueAt,
        assignee: validated.payload.assignee,
        done_at: null,
        done_by: null,
        source: 'manual',
      })
      .select('*');

    const rows = Array.isArray(res.data) ? res.data : res.data ? [res.data] : [];
    if (res.error || rows.length === 0) {
      throw new Error(res.error?.message ?? 'Failed to insert task');
    }

    created = parseTaskRow(rows[0]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const offline = isNetworkFailureMessage(message);
    return {
      ok: false,
      errorCode: offline ? 'NETWORK_ERROR' : 'SAVE_TASK_FAILED',
      isOffline: offline,
    };
  }

  await refreshTodayAfterSave(deps);
  return { ok: true, task: created };
}

export async function updateTask(
  input: TaskDraftInput & {
    taskId: string;
    memberRole?: MemberRole;
  },
  deps: TasksDeps = {},
): Promise<SaveTaskResult> {
  if (input.memberRole === 'viewer') {
    return { ok: false, errorCode: 'FORBIDDEN_ROLE', isOffline: false };
  }

  if (!input.taskId.trim()) {
    return { ok: false, errorCode: 'VALIDATION_ERROR', isOffline: false };
  }

  const validated = validateTaskDraft(input);
  if (!validated.ok) {
    return { ok: false, errorCode: validated.errorCode, isOffline: false };
  }

  if (deps.isOffline) {
    return { ok: false, errorCode: 'NETWORK_ERROR', isOffline: true };
  }

  const mocks = loadCareCircleMocks(deps.env);
  if (mocks) {
    const snapshot = getOrInitMockTodaySnapshot(mocks);
    const idx = snapshot.tasks.findIndex(
      (t) => t.id === input.taskId && t.circleId === validated.payload.circleId,
    );
    if (idx < 0) {
      return { ok: false, errorCode: 'SAVE_TASK_FAILED', isOffline: false };
    }
    const existing = snapshot.tasks[idx]!;
    const updated: Task = {
      ...existing,
      title: validated.payload.title,
      dueAt: validated.payload.dueAt,
      assignee: validated.payload.assignee,
    };
    snapshot.tasks[idx] = updated;
    await refreshTodayAfterSave(deps);
    return { ok: true, task: updated };
  }

  const getClient = deps.getClient ?? getSupabaseClient;
  let updated: Task;

  try {
    const client = getClient();
    const res = await client
      .from('tasks')
      .update({
        title: validated.payload.title,
        due_at: validated.payload.dueAt,
        assignee: validated.payload.assignee,
      })
      .eq('id', input.taskId)
      .eq('circle_id', validated.payload.circleId)
      .select('*');

    const rows = Array.isArray(res.data) ? res.data : res.data ? [res.data] : [];
    if (res.error || rows.length === 0) {
      throw new Error(res.error?.message ?? 'Failed to update task');
    }

    updated = parseTaskRow(rows[0]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const offline = isNetworkFailureMessage(message);
    return {
      ok: false,
      errorCode: offline ? 'NETWORK_ERROR' : 'SAVE_TASK_FAILED',
      isOffline: offline,
    };
  }

  await refreshTodayAfterSave(deps);
  return { ok: true, task: updated };
}

export async function setTaskCompletion(
  input: {
    circleId: string;
    taskId: string;
    completed: boolean;
    currentUserId: string;
    memberRole?: MemberRole;
  },
  deps: TasksDeps = {},
): Promise<SaveTaskResult> {
  if (input.memberRole === 'viewer') {
    return { ok: false, errorCode: 'FORBIDDEN_ROLE', isOffline: false };
  }

  if (!input.circleId.trim() || !input.taskId.trim()) {
    return { ok: false, errorCode: 'VALIDATION_ERROR', isOffline: false };
  }

  if (deps.isOffline) {
    return { ok: false, errorCode: 'NETWORK_ERROR', isOffline: true };
  }

  const nowIso = (deps.now ? deps.now() : new Date()).toISOString();
  const doneAt = input.completed ? nowIso : null;
  const doneBy = input.completed ? input.currentUserId : null;

  const mocks = loadCareCircleMocks(deps.env);
  if (mocks) {
    const snapshot = getOrInitMockTodaySnapshot(mocks);
    const idx = snapshot.tasks.findIndex(
      (t) => t.id === input.taskId && t.circleId === input.circleId,
    );
    if (idx < 0) {
      return { ok: false, errorCode: 'SAVE_TASK_FAILED', isOffline: false };
    }
    const updated: Task = {
      ...snapshot.tasks[idx]!,
      doneAt,
      doneBy,
    };
    snapshot.tasks[idx] = updated;
    await refreshTodayAfterSave(deps);
    return { ok: true, task: updated };
  }

  const getClient = deps.getClient ?? getSupabaseClient;
  let updated: Task;

  try {
    const client = getClient();
    const res = await client
      .from('tasks')
      .update({
        done_at: doneAt,
        done_by: doneBy,
      })
      .eq('id', input.taskId)
      .eq('circle_id', input.circleId)
      .select('*');

    const rows = Array.isArray(res.data) ? res.data : res.data ? [res.data] : [];
    if (res.error || rows.length === 0) {
      throw new Error(res.error?.message ?? 'Failed to update task completion');
    }

    updated = parseTaskRow(rows[0]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const offline = isNetworkFailureMessage(message);
    return {
      ok: false,
      errorCode: offline ? 'NETWORK_ERROR' : 'SAVE_TASK_FAILED',
      isOffline: offline,
    };
  }

  await refreshTodayAfterSave(deps);
  return { ok: true, task: updated };
}
