export const MISSED_THRESHOLD_MINUTES = 60;

export const MISSED_PUSH_TITLE = 'A dose was missed';
export const MISSED_PUSH_BODY = 'Open CareCircle to check the care plan.';

export interface OverdueDoseRow {
  id: string;
  medication_id: string;
  circle_id: string;
  due_at: string;
  status: 'pending' | 'given' | 'skipped' | 'missed';
  acted_by: string | null;
  acted_at: string | null;
}

export interface MarkMissedStore {
  /**
   * Returns `pending` doses with `due_at <= cutoffIso` (paged so >1000 rows are not truncated).
   */
  listOverduePendingDoses(cutoffIso: string): Promise<OverdueDoseRow[]>;
  /**
   * Atomically transitions a dose from `pending` to `missed` (`where id = $1 and status = 'pending'`),
   * leaving `acted_by = null` and `acted_at = null`. Returns `{ updated: true }` only when the row
   * actually changed from `pending` to `missed`.
   */
  markDoseMissedIfPending(doseEventId: string): Promise<{ updated: boolean }>;
  /**
   * Returns the `user_id`s of members in `circleId` whose role is `'owner'` or `'helper'`
   * (never `'viewer'`).
   */
  listCircleOwnerAndHelperUserIds(circleId: string): Promise<string[]>;
}

export interface MarkMissedPushPayload {
  userIds: string[];
  title: string;
  body: string;
  data: {
    type: 'missed_dose';
    circleId: string;
    doseEventId: string;
    medicationId: string;
  };
}

export interface MarkMissedHandlerDeps {
  cronSecret?: string;
  now?: () => Date;
  store: MarkMissedStore;
  sendPush: (payload: MarkMissedPushPayload) => Promise<{ ok: boolean; sent?: number }>;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function createMarkMissedHandler(
  deps: MarkMissedHandlerDeps,
): (req: Request) => Promise<Response> {
  const nowFn = deps.now ?? (() => new Date());

  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') {
      return jsonResponse({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
    }

    const cronSecret = deps.cronSecret ?? '';
    if (!cronSecret) {
      return jsonResponse({ ok: false, error: 'CRON_SECRET_NOT_CONFIGURED' }, 500);
    }

    const authHeader = req.headers.get('authorization') ?? '';
    const hasBearerPrefix = authHeader.startsWith('Bearer ');
    const callerSecret = hasBearerPrefix ? authHeader.slice('Bearer '.length) : '';
    if (!hasBearerPrefix || !constantTimeEquals(callerSecret, cronSecret)) {
      return jsonResponse({ ok: false, error: 'UNAUTHORIZED' }, 401);
    }

    const now = nowFn();
    const cutoffMs = now.getTime() - MISSED_THRESHOLD_MINUTES * 60_000;
    const cutoffIso = new Date(cutoffMs).toISOString();

    let overdueDoses: OverdueDoseRow[];
    try {
      overdueDoses = await deps.store.listOverduePendingDoses(cutoffIso);
    } catch {
      console.info(
        JSON.stringify({
          event: 'mark_missed_run',
          ok: false,
          missed: 0,
          failed: 1,
        }),
      );
      return jsonResponse({ ok: false, missed: 0, failed: 1 }, 500);
    }

    let missed = 0;
    let failed = 0;

    for (const dose of overdueDoses) {
      if (dose.status !== 'pending' || Date.parse(dose.due_at) > cutoffMs) {
        continue;
      }

      let updated = false;
      try {
        const res = await deps.store.markDoseMissedIfPending(dose.id);
        updated = res.updated;
      } catch {
        failed += 1;
        continue;
      }

      if (!updated) {
        continue;
      }

      missed += 1;

      try {
        const rawRecipients = await deps.store.listCircleOwnerAndHelperUserIds(dose.circle_id);
        const userIds = Array.from(new Set(rawRecipients));
        if (userIds.length > 0) {
          const pushRes = await deps.sendPush({
            userIds,
            title: MISSED_PUSH_TITLE,
            body: MISSED_PUSH_BODY,
            data: {
              type: 'missed_dose',
              circleId: dose.circle_id,
              doseEventId: dose.id,
              medicationId: dose.medication_id,
            },
          });
          if (!pushRes.ok) {
            failed += 1;
          }
        }
      } catch {
        failed += 1;
      }
    }

    console.info(
      JSON.stringify({
        event: 'mark_missed_run',
        ok: failed === 0,
        missed,
        failed,
      }),
    );

    if (failed > 0) {
      return jsonResponse({ ok: false, missed, failed }, 500);
    }
    return jsonResponse({ ok: true, missed, failed: 0 }, 200);
  };
}
