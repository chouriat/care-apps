import type { MarkMissedStore, OverdueDoseRow } from './handler.ts';

/**
 * PostgREST returns at most `max_rows` rows per request (1000 in config.toml and on hosted
 * Supabase by default) and silently drops the rest. Overdue pending doses are therefore read in
 * pages of 500 ordered by `id.asc` until a page comes back short or empty.
 */
export const DOSE_PAGE_SIZE = 500;

interface CircleMemberRoleRow {
  circle_id: string;
  user_id: string;
  role: 'owner' | 'helper' | 'viewer';
}

export interface SendPushPayloadLike {
  userIds: string[];
  title: string;
  body: string;
  data: Record<string, string>;
}

export function createMarkMissedPostgrestStore(
  supabaseUrl: string,
  serviceRoleKey: string,
  fetchImpl: typeof fetch = fetch,
): MarkMissedStore {
  const baseUrl = supabaseUrl.replace(/\/+$/, '');
  const authHeaders = {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
  };

  return {
    async listOverduePendingDoses(cutoffIso: string): Promise<OverdueDoseRow[]> {
      const select = 'select=id,medication_id,circle_id,due_at,status,acted_by,acted_at';
      const result: OverdueDoseRow[] = [];
      let afterId: string | null = null;

      for (;;) {
        const filters = [`status=eq.pending`, `due_at=lte.${encodeURIComponent(cutoffIso)}`];
        if (afterId !== null) {
          filters.push(`id=gt.${encodeURIComponent(afterId)}`);
        }
        const res = await fetchImpl(
          `${baseUrl}/rest/v1/dose_events?${filters.join('&')}&${select}&order=id.asc&limit=${DOSE_PAGE_SIZE}`,
          {
            method: 'GET',
            headers: {
              ...authHeaders,
              accept: 'application/json',
            },
          },
        );
        if (!res.ok) {
          throw new Error(`listOverduePendingDoses failed with HTTP ${res.status}`);
        }
        const rows = (await res.json()) as OverdueDoseRow[];
        if (!Array.isArray(rows)) {
          throw new Error('listOverduePendingDoses returned a non-array body');
        }
        for (const row of rows) {
          result.push(row);
        }
        const last = rows[rows.length - 1];
        if (last === undefined || rows.length < DOSE_PAGE_SIZE) {
          return result;
        }
        afterId = last.id;
      }
    },

    async markDoseMissedIfPending(doseEventId: string): Promise<{ updated: boolean }> {
      const res = await fetchImpl(
        `${baseUrl}/rest/v1/dose_events?id=eq.${encodeURIComponent(doseEventId)}&status=eq.pending`,
        {
          method: 'PATCH',
          headers: {
            ...authHeaders,
            'content-type': 'application/json',
            prefer: 'return=representation',
          },
          body: JSON.stringify({ status: 'missed' }),
        },
      );
      if (!res.ok) {
        throw new Error(`markDoseMissedIfPending failed with HTTP ${res.status}`);
      }
      const updatedRows = (await res.json()) as Array<{ id: string }>;
      return { updated: Array.isArray(updatedRows) && updatedRows.length > 0 };
    },

    async listCircleOwnerAndHelperUserIds(circleId: string): Promise<string[]> {
      const res = await fetchImpl(
        `${baseUrl}/rest/v1/circle_members?circle_id=eq.${encodeURIComponent(circleId)}&role=in.(owner,helper)&select=circle_id,user_id,role`,
        {
          method: 'GET',
          headers: {
            ...authHeaders,
            accept: 'application/json',
          },
        },
      );
      if (!res.ok) {
        throw new Error(`listCircleOwnerAndHelperUserIds failed with HTTP ${res.status}`);
      }
      const rows = (await res.json()) as CircleMemberRoleRow[];
      if (!Array.isArray(rows)) {
        throw new Error('listCircleOwnerAndHelperUserIds returned a non-array body');
      }
      const userIds = rows
        .filter(
          (row) => row.circle_id === circleId && (row.role === 'owner' || row.role === 'helper'),
        )
        .map((row) => row.user_id);
      return Array.from(new Set(userIds));
    },
  };
}

export function createSendPushViaFunction(
  supabaseUrl: string,
  serviceRoleKey: string,
  fetchImpl: typeof fetch = fetch,
): (payload: SendPushPayloadLike) => Promise<{ ok: boolean; sent?: number }> {
  const baseUrl = supabaseUrl.replace(/\/+$/, '');

  return async (payload: SendPushPayloadLike): Promise<{ ok: boolean; sent?: number }> => {
    const res = await fetchImpl(`${baseUrl}/functions/v1/send-push`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${serviceRoleKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      return { ok: false };
    }

    try {
      const parsed = (await res.json()) as { ok?: unknown; sent?: unknown };
      if (!parsed || typeof parsed !== 'object' || parsed.ok !== true) {
        return { ok: false };
      }
      return {
        ok: true,
        ...(typeof parsed.sent === 'number' ? { sent: parsed.sent } : {}),
      };
    } catch {
      return { ok: false };
    }
  };
}
