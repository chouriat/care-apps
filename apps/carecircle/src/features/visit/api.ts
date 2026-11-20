import {
  createAiGatewayClient,
  summarizeVisitInputSchema,
  summarizeVisitOutputSchema,
  type AiFetch,
  type AiGatewayResponse,
  type SummarizeVisitInput,
  type SummarizeVisitOutput,
} from '@carecircle/ai-gateway';
import {
  circleRowSchema,
  medicationRowSchema,
  taskRowSchema,
  validateAnalyticsEvent,
  visitNoteRowSchema,
  type Circle,
  type CircleRow,
  type Medication,
  type MedicationRow,
  type MemberRole,
  type Task,
  type TaskRow,
  type VisitNote,
  type VisitNoteRow,
} from '@carecircle/core';
import { getSupabaseClient } from '../auth/api';
import { fetchSignedInMemberRole } from '../circle/api';
import { type MedsDeps } from '../meds/api';
import { loadCareCircleMocks } from '../mocks';
import { getAppObservability } from '../observability/api';
import { getOrInitMockTodaySnapshot, loadTodaySnapshot } from '../today/api';
import { requestTodayReload } from '../today/refresh';
import {
  createVisitAudioId,
  deleteVisitAudioObject,
  uploadVisitAudio,
  type VisitStorageSupabaseLike,
} from './storage';

const ISO_DATE_REGEX = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export interface VisitKnownMed {
  id: string;
  name: string;
  strength: string | null;
}

export interface SummarizeVisitApiDeps extends MedsDeps {
  supabase?: VisitStorageSupabaseLike & {
    auth?: {
      getSession: () => Promise<{ data: { session: { access_token: string } | null } }>;
    };
  };
  baseUrl?: string;
  getAccessToken?: () => Promise<string | null> | string | null;
  fetchImpl?: AiFetch;
  requestId?: string;
  audioId?: string;
  deleteLocalFile?: (uri: string) => void;
  callSummarizeVisit?: (
    input: SummarizeVisitCallInput,
  ) => Promise<AiGatewayResponse<SummarizeVisitOutput>>;
  trackVisitNoteSaved?: (counts: { followUps: number; medChanges: number }) => void;
}

export type SummarizeVisitCallInput =
  | {
      circleId: string;
      text: string;
      knownMeds: VisitKnownMed[];
      audioBytes?: undefined;
      audioPath?: undefined;
    }
  | {
      circleId: string;
      audioPath: string;
      text?: string;
      knownMeds: VisitKnownMed[];
      audioBytes?: undefined;
    }
  | {
      circleId: string;
      audioBytes: Uint8Array;
      contentType?: 'audio/m4a' | 'audio/mp4';
      localUri?: string;
      text?: string;
      knownMeds: VisitKnownMed[];
      audioPath?: undefined;
    };

export async function summarizeVisit(
  input: SummarizeVisitCallInput,
  deps: SummarizeVisitApiDeps = {},
): Promise<AiGatewayResponse<SummarizeVisitOutput>> {
  if (deps.callSummarizeVisit) {
    return deps.callSummarizeVisit(input);
  }

  const mocks = loadCareCircleMocks(deps.env);
  if (mocks && !deps.supabase && !deps.fetchImpl) {
    if (input.audioBytes !== undefined && input.localUri) {
      deps.deleteLocalFile?.(input.localUri);
    }
    return {
      ok: true,
      output: summarizeVisitOutputSchema.parse(mocks.aiResponses.summarizeVisit),
      model: 'mock/visit-summariser',
      latencyMs: 12,
    };
  }

  const supabase =
    deps.supabase ??
    (getSupabaseClient() as unknown as NonNullable<SummarizeVisitApiDeps['supabase']>);
  const baseUrl =
    deps.baseUrl ?? process.env.EXPO_PUBLIC_SUPABASE_URL?.trim() ?? 'http://127.0.0.1:54321';

  const getAccessToken =
    deps.getAccessToken ??
    (async () => {
      const res = await supabase.auth?.getSession();
      return res?.data?.session?.access_token ?? null;
    });

  const client = createAiGatewayClient({
    baseUrl,
    getAccessToken,
    fetchImpl: deps.fetchImpl,
  });

  let uploadedAudioPath: string | null = null;
  try {
    if (input.audioBytes !== undefined) {
      try {
        const uploaded = await uploadVisitAudio({
          supabase,
          circleId: input.circleId,
          audioId: deps.audioId,
          bytes: input.audioBytes,
          contentType: input.contentType ?? 'audio/m4a',
        });
        uploadedAudioPath = uploaded.audioPath;
      } finally {
        if (input.localUri) {
          deps.deleteLocalFile?.(input.localUri);
        }
      }
    }

    const gatewayInput: SummarizeVisitInput = {
      circleId: input.circleId,
      ...(uploadedAudioPath
        ? { audioPath: uploadedAudioPath }
        : input.audioPath
          ? { audioPath: input.audioPath }
          : {}),
      ...(input.text ? { text: input.text } : {}),
      knownMeds: input.knownMeds,
    };

    const parsedInput = summarizeVisitInputSchema.safeParse(gatewayInput);
    if (!parsedInput.success) {
      return {
        ok: false,
        error: {
          code: 'INPUT_INVALID',
          message: 'Invalid visit summary input.',
          retryable: false,
        },
      };
    }

    const requestId = deps.requestId ?? createVisitAudioId();
    return await client.call(
      {
        requestId,
        task: 'carecircle.summarizeVisit',
        input: parsedInput.data,
      },
      summarizeVisitOutputSchema,
    );
  } finally {
    if (uploadedAudioPath) {
      await deleteVisitAudioObject({ supabase, audioPath: uploadedAudioPath }).catch(
        () => undefined,
      );
    }
  }
}

interface LocalWallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function extractLocalParts(formatter: Intl.DateTimeFormat, utcMs: number): LocalWallParts {
  const parts = formatter.formatToParts(new Date(utcMs));
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === 'year') year = Number.parseInt(part.value, 10);
    else if (part.type === 'month') month = Number.parseInt(part.value, 10);
    else if (part.type === 'day') day = Number.parseInt(part.value, 10);
    else if (part.type === 'hour') {
      const h = Number.parseInt(part.value, 10);
      hour = h === 24 ? 0 : h;
    } else if (part.type === 'minute') minute = Number.parseInt(part.value, 10);
  }
  return { year, month, day, hour, minute };
}

function wallPartsKey(p: LocalWallParts): number {
  return (((p.year * 100 + p.month) * 100 + p.day) * 100 + p.hour) * 100 + p.minute;
}

/**
 * Converts a `YYYY-MM-DD` date in the circle's IANA timezone to the UTC ISO timestamp
 * corresponding to local midnight (`00:00`) on that date (or the first valid minute if
 * midnight is skipped by a DST transition).
 */
export function resolveLocalMidnightInTimezoneToUtc(localDate: string, timeZone: string): string {
  const match = ISO_DATE_REGEX.exec(localDate.trim());
  if (!match) {
    throw new Error(`Invalid calendar date "${localDate}"; expected YYYY-MM-DD`);
  }
  const year = Number.parseInt(match[1] ?? '', 10);
  const month = Number.parseInt(match[2] ?? '', 10);
  const day = Number.parseInt(match[3] ?? '', 10);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() + 1 !== month ||
    probe.getUTCDate() !== day
  ) {
    throw new Error(`Non-existent calendar date "${localDate}"`);
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const targetKey = wallPartsKey({ year, month, day, hour: 0, minute: 0 });
  const noonUtcMs = Date.UTC(year, month - 1, day, 12, 0, 0, 0);
  const noonLocal = extractLocalParts(formatter, noonUtcMs);
  const noonLocalAsUtcMs = Date.UTC(
    noonLocal.year,
    noonLocal.month - 1,
    noonLocal.day,
    noonLocal.hour,
    noonLocal.minute,
    0,
    0,
  );
  const approxOffsetMs = noonLocalAsUtcMs - noonUtcMs;
  const approxUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0) - approxOffsetMs;

  if (wallPartsKey(extractLocalParts(formatter, approxUtcMs)) === targetKey) {
    for (const shiftMinutes of [60, 30]) {
      const earlierMs = approxUtcMs - shiftMinutes * 60_000;
      if (wallPartsKey(extractLocalParts(formatter, earlierMs)) === targetKey) {
        return new Date(earlierMs).toISOString();
      }
    }
    return new Date(approxUtcMs).toISOString();
  }

  const scanStartMs = approxUtcMs - 180 * 60_000;
  const scanEndMs = approxUtcMs + 180 * 60_000;
  let firstAfterGapMs: number | null = null;

  for (let probeMs = scanStartMs; probeMs <= scanEndMs; probeMs += 60_000) {
    const parts = extractLocalParts(formatter, probeMs);
    const key = wallPartsKey(parts);
    if (key === targetKey) {
      return new Date(probeMs).toISOString();
    }
    if (firstAfterGapMs === null && key > targetKey) {
      firstAfterGapMs = probeMs;
    }
  }

  if (firstAfterGapMs !== null) {
    return new Date(firstAfterGapMs).toISOString();
  }

  throw new Error(`Could not resolve local midnight for ${localDate} in ${timeZone}`);
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

function medicationFromRow(row: MedicationRow): Medication {
  return {
    id: row.id,
    circleId: row.circle_id,
    name: row.name,
    strength: row.strength,
    doseText: row.dose_text,
    schedule: row.schedule,
    instructions: row.instructions,
    startDate: row.start_date,
    endDate: row.end_date,
    active: row.active,
    source: row.source,
  };
}

function visitNoteFromRow(row: VisitNoteRow): VisitNote {
  return {
    id: row.id,
    circleId: row.circle_id,
    appointmentId: row.appointment_id,
    transcript: row.transcript,
    summary: row.summary,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function taskFromRow(row: TaskRow): Task {
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

async function resolveUserId(deps: SummarizeVisitApiDeps): Promise<string | null> {
  try {
    if (deps.getUserId) return await deps.getUserId();
    const { data } = await getSupabaseClient().auth.getSession();
    return data.session?.user.id ?? null;
  } catch {
    return null;
  }
}

async function refreshTodayAfterVisitSave(deps: SummarizeVisitApiDeps): Promise<void> {
  try {
    await loadTodaySnapshot(deps);
  } catch {
    // Today reloads on its next open or retry.
  }
  requestTodayReload();
}

export function defaultTrackVisitNoteSaved(counts: {
  followUps: number;
  medChanges: number;
}): void {
  const payload = validateAnalyticsEvent('cc_visit_note_saved', {
    followUps: counts.followUps,
    medChanges: counts.medChanges,
  });
  void getAppObservability()
    .analytics.track('cc_visit_note_saved', payload as { followUps: number; medChanges: number })
    .catch(() => undefined);
}

export async function loadVisitNoteContext(deps: SummarizeVisitApiDeps = {}): Promise<{
  status: 'ok' | 'no_circle' | 'error';
  circle: Circle | null;
  memberRole: MemberRole;
  activeMedications: Medication[];
}> {
  const mocks = loadCareCircleMocks(deps.env);
  if (mocks) {
    const snapshot = getOrInitMockTodaySnapshot(mocks);
    return {
      status: 'ok',
      circle: snapshot.circle,
      memberRole: snapshot.memberRole,
      activeMedications: snapshot.medications.filter((m) => m.active),
    };
  }

  const getClient = deps.getClient ?? getSupabaseClient;
  const userId = await resolveUserId(deps);

  try {
    const client = getClient();
    const circlesRes = await client
      .from('circles')
      .select('*')
      .order('created_at', { ascending: true })
      .limit(1);

    if (circlesRes.error) {
      return { status: 'error', circle: null, memberRole: 'viewer', activeMedications: [] };
    }

    const circleRows = Array.isArray(circlesRes.data) ? circlesRes.data : [];
    if (circleRows.length === 0) {
      return { status: 'no_circle', circle: null, memberRole: 'viewer', activeMedications: [] };
    }

    const rawCircle = { ...(circleRows[0] as Record<string, unknown>) };
    rawCircle.created_at = normalizeIsoTimestamp(rawCircle.created_at);
    const circle = circleFromRow(circleRowSchema.parse(rawCircle));

    const [roleRes, medsRes] = await Promise.all([
      fetchSignedInMemberRole(client, circle.id, userId),
      client.from('medications').select('*').eq('circle_id', circle.id),
    ]);

    if (roleRes.error || medsRes.error) {
      return { status: 'error', circle: null, memberRole: 'viewer', activeMedications: [] };
    }

    const medications = (Array.isArray(medsRes.data) ? medsRes.data : []).map((row) =>
      medicationFromRow(medicationRowSchema.parse(row)),
    );

    return {
      status: 'ok',
      circle,
      memberRole: roleRes.role,
      activeMedications: medications.filter((m) => m.active),
    };
  } catch {
    return { status: 'error', circle: null, memberRole: 'viewer', activeMedications: [] };
  }
}

export async function saveVisitNoteRow(
  input: {
    circleId: string;
    appointmentId?: string | null;
    transcript: string | null;
    summary: string;
    memberRole?: MemberRole;
  },
  deps: SummarizeVisitApiDeps = {},
): Promise<
  | { ok: true; visitNote: VisitNote }
  | { ok: false; errorCode: 'FORBIDDEN_ROLE' | 'VALIDATION_ERROR' | 'SAVE_FAILED' }
> {
  if (input.memberRole === 'viewer') {
    return { ok: false, errorCode: 'FORBIDDEN_ROLE' };
  }

  const trimmedSummary = input.summary.trim();
  if (!input.circleId.trim() || !trimmedSummary) {
    return { ok: false, errorCode: 'VALIDATION_ERROR' };
  }

  const trimmedTranscript = input.transcript?.trim() ? input.transcript.trim() : null;
  const appointmentId = input.appointmentId?.trim() ? input.appointmentId.trim() : null;
  const mocks = loadCareCircleMocks(deps.env);

  if (mocks) {
    const userId = (await resolveUserId(deps)) ?? mocks.circle.createdBy;
    const nowIso = (deps.now ? deps.now() : new Date()).toISOString();
    const created: VisitNote = {
      id: createVisitAudioId(),
      circleId: input.circleId,
      appointmentId,
      transcript: trimmedTranscript,
      summary: trimmedSummary,
      createdBy: userId,
      createdAt: nowIso,
    };
    (mocks.visitNotes as VisitNote[]).push(created);
    return { ok: true, visitNote: created };
  }

  const getClient = deps.getClient ?? getSupabaseClient;
  try {
    const client = getClient();
    // created_by is set by the database default (auth.uid()) and is not in the column-level
    // insert grant for authenticated users.
    const res = await client
      .from('visit_notes')
      .insert({
        circle_id: input.circleId.trim(),
        ...(appointmentId ? { appointment_id: appointmentId } : {}),
        transcript: trimmedTranscript,
        summary: trimmedSummary,
      })
      .select('*');

    if (res.error) {
      return { ok: false, errorCode: 'SAVE_FAILED' };
    }

    const rows = Array.isArray(res.data) ? res.data : [];
    if (rows.length === 0) {
      return { ok: false, errorCode: 'SAVE_FAILED' };
    }

    const rawRow = { ...(rows[0] as Record<string, unknown>) };
    rawRow.created_at = normalizeIsoTimestamp(rawRow.created_at);
    return { ok: true, visitNote: visitNoteFromRow(visitNoteRowSchema.parse(rawRow)) };
  } catch {
    return { ok: false, errorCode: 'SAVE_FAILED' };
  }
}

export async function saveFollowUpTask(
  input: {
    circleId: string;
    title: string;
    dueDate: string | null;
    timezone: string;
    memberRole?: MemberRole;
  },
  deps: SummarizeVisitApiDeps = {},
): Promise<
  | { ok: true; task: Task }
  | { ok: false; errorCode: 'FORBIDDEN_ROLE' | 'VALIDATION_ERROR' | 'SAVE_FAILED' }
> {
  if (input.memberRole === 'viewer') {
    return { ok: false, errorCode: 'FORBIDDEN_ROLE' };
  }

  const trimmedTitle = input.title.trim();
  if (!input.circleId.trim() || !trimmedTitle) {
    return { ok: false, errorCode: 'VALIDATION_ERROR' };
  }

  let dueAt: string | null = null;
  if (input.dueDate && input.dueDate.trim().length > 0) {
    try {
      dueAt = resolveLocalMidnightInTimezoneToUtc(input.dueDate.trim(), input.timezone);
    } catch {
      return { ok: false, errorCode: 'VALIDATION_ERROR' };
    }
  }

  const mocks = loadCareCircleMocks(deps.env);
  if (mocks) {
    const snapshot = getOrInitMockTodaySnapshot(mocks);
    const created: Task = {
      id: createVisitAudioId(),
      circleId: input.circleId,
      title: trimmedTitle,
      dueAt,
      assignee: null,
      doneAt: null,
      doneBy: null,
      source: 'visit_note',
    };
    snapshot.tasks.push(created);
    await refreshTodayAfterVisitSave(deps);
    return { ok: true, task: created };
  }

  const getClient = deps.getClient ?? getSupabaseClient;
  try {
    const client = getClient();
    const res = await client
      .from('tasks')
      .insert({
        circle_id: input.circleId.trim(),
        title: trimmedTitle,
        due_at: dueAt,
        source: 'visit_note',
      })
      .select('*');

    if (res.error) {
      return { ok: false, errorCode: 'SAVE_FAILED' };
    }

    const rows = Array.isArray(res.data) ? res.data : [];
    if (rows.length === 0) {
      return { ok: false, errorCode: 'SAVE_FAILED' };
    }

    const rawRow = { ...(rows[0] as Record<string, unknown>) };
    rawRow.due_at = normalizeIsoTimestamp(rawRow.due_at);
    rawRow.done_at = normalizeIsoTimestamp(rawRow.done_at);
    const task = taskFromRow(taskRowSchema.parse(rawRow));
    await refreshTodayAfterVisitSave(deps);
    return { ok: true, task };
  } catch {
    return { ok: false, errorCode: 'SAVE_FAILED' };
  }
}
