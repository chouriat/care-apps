import {
  isNetworkFailureMessage,
  validateAnalyticsEvent,
  type LogType,
  type MemberRole,
} from '@carecircle/core';
import { Share } from 'react-native';
import en from '../../../i18n/en.json';
import { getSupabaseClient } from '../auth/api';
import { fetchSignedInMemberRole } from '../circle/api';
import { getAppObservability } from '../observability/api';

export const CARE_LOG_PAGE_SIZE = 50;
export const MAX_EXPORT_RANGE_DAYS = 90;

export const ALL_LOG_TYPES: ReadonlyArray<LogType> = [
  'dose',
  'med_change',
  'appointment',
  'task',
  'visit_note',
  'member',
];

export interface CareLogMemberOption {
  userId: string;
  displayName: string;
}

export interface CareLogEntryItem {
  id: string;
  circleId: string;
  type: LogType;
  refId: string | null;
  summary: string | null;
  createdBy: string | null;
  createdAt: string;
  actorDisplayName: string;
}

export interface CareLogDeps {
  getClient?: () => ReturnType<typeof getSupabaseClient>;
  getUserId?: () => Promise<string | null>;
  now?: () => Date;
  isOffline?: boolean;
  isFamilyPlan?: boolean;
  shareUrl?: (pdfUrl: string) => Promise<void>;
  trackLogExported?: (days: number) => void;
  trackPaywallViewed?: () => void;
}

export type LoadCareLogContextResult =
  | {
      ok: true;
      circleId: string;
      circleName: string;
      timezone: string;
      memberRole: MemberRole;
      isFamilyPlan: boolean;
      members: CareLogMemberOption[];
      defaultFrom: string;
      defaultTo: string;
    }
  | {
      ok: false;
      isOffline: boolean;
    };

export type FetchCareLogPageResult =
  | {
      ok: true;
      entries: CareLogEntryItem[];
      hasMore: boolean;
    }
  | {
      ok: false;
      isOffline: boolean;
    };

export type ExportCareLogPdfResult =
  | {
      ok: true;
      pdfUrl: string;
      days: number;
    }
  | {
      ok: false;
      errorCode: 'QUOTA_EXCEEDED' | 'RANGE_INVALID' | 'NETWORK_ERROR' | 'EXPORT_FAILED';
      isOffline: boolean;
    };

const DATE_ONLY_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseCalendarDateUtcMs(dateStr: string): number | null {
  const match = DATE_ONLY_REGEX.exec(dateStr.trim());
  if (!match) return null;
  const year = Number.parseInt(match[1] ?? '', 10);
  const month = Number.parseInt(match[2] ?? '', 10);
  const day = Number.parseInt(match[3] ?? '', 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return ms;
}

function formatUtcMsAsDateOnly(ms: number): string {
  const d = new Date(ms);
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function computeExportRangeDays(from: string, to: string): number | null {
  const fromMs = parseCalendarDateUtcMs(from);
  const toMs = parseCalendarDateUtcMs(to);
  if (fromMs === null || toMs === null || fromMs > toMs) {
    return null;
  }
  const days = Math.round((toMs - fromMs) / 86_400_000) + 1;
  if (days < 1 || days > MAX_EXPORT_RANGE_DAYS) {
    return null;
  }
  return days;
}

export function getDefaultExportDateRange(
  now: Date,
  timeZone: string,
): { from: string; to: string } {
  let todayStr = formatUtcMsAsDateOnly(now.getTime());
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const y = parts.find((p) => p.type === 'year')?.value;
    const m = parts.find((p) => p.type === 'month')?.value;
    const d = parts.find((p) => p.type === 'day')?.value;
    if (y && m && d) {
      todayStr = `${y}-${m}-${d}`;
    }
  } catch {
    // Keep UTC date fallback.
  }
  const toMs = parseCalendarDateUtcMs(todayStr) ?? now.getTime();
  // Default last 30 days inclusive (`to - 29 days` through `to`)
  const fromStr = formatUtcMsAsDateOnly(toMs - 29 * 86_400_000);
  return { from: fromStr, to: todayStr };
}

export function formatCareLogTimestamp(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(d);
    const y = parts.find((p) => p.type === 'year')?.value ?? '1970';
    const m = parts.find((p) => p.type === 'month')?.value ?? '01';
    const day = parts.find((p) => p.type === 'day')?.value ?? '01';
    const hRaw = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const min = parts.find((p) => p.type === 'minute')?.value ?? '00';
    const h = hRaw === '24' ? '00' : hRaw.padStart(2, '0');
    return `${y}-${m}-${day} ${h}:${min}`;
  } catch {
    return iso;
  }
}

export function defaultTrackLogExported(days: number): void {
  const payload = validateAnalyticsEvent('cc_log_exported', { days });
  void getAppObservability()
    .analytics.track('cc_log_exported', payload as { days: number })
    .catch(() => undefined);
}

export function defaultTrackPaywallViewed(): void {
  const payload = validateAnalyticsEvent('cc_paywall_viewed', { trigger: 'pdf_export' });
  void getAppObservability()
    .analytics.track('cc_paywall_viewed', payload as { trigger: 'pdf_export' })
    .catch(() => undefined);
}

async function resolveUserId(deps: CareLogDeps): Promise<string | null> {
  try {
    if (deps.getUserId) return await deps.getUserId();
    const client = (deps.getClient ?? getSupabaseClient)();
    const { data } = await client.auth.getSession();
    return data.session?.user.id ?? null;
  } catch {
    return null;
  }
}

export async function loadCareLogContext(
  deps: CareLogDeps = {},
): Promise<LoadCareLogContextResult> {
  if (deps.isOffline) {
    return { ok: false, isOffline: true };
  }
  const getClient = deps.getClient ?? getSupabaseClient;
  const now = deps.now ? deps.now() : new Date();

  try {
    const client = getClient();
    const userId = await resolveUserId(deps);
    if (!userId) return { ok: false, isOffline: false };

    const circleRes = await client
      .from('circles')
      .select('id, name, care_recipient_name, care_recipient_dob, timezone, created_by, created_at')
      .order('created_at', { ascending: true })
      .limit(1);

    if (circleRes.error || !Array.isArray(circleRes.data) || !circleRes.data[0]) {
      const errMsg = circleRes.error?.message ?? '';
      return { ok: false, isOffline: isNetworkFailureMessage(errMsg, circleRes.error?.code) };
    }

    const rawCircle = circleRes.data[0] as {
      id: string;
      name: string;
      timezone: string;
    };
    const circleId = rawCircle.id;
    const timezone = rawCircle.timezone || 'UTC';
    const roleRes = await fetchSignedInMemberRole(client, circleId, userId);
    const memberRole = roleRes.role;

    const membersRes = await client
      .from('circle_members')
      .select('user_id, role, joined_at')
      .eq('circle_id', circleId)
      .order('joined_at', { ascending: true });

    const memberRows = Array.isArray(membersRes.data)
      ? (membersRes.data as Array<{ user_id: string; role: string }>)
      : [];

    const memberIds = memberRows.map((m) => m.user_id).filter(Boolean);
    const displayMap = new Map<string, string>();
    if (memberIds.length > 0) {
      const profilesRes = await client
        .from('users_profile')
        .select('user_id, display_name')
        .in('user_id', memberIds);
      if (Array.isArray(profilesRes.data)) {
        for (const p of profilesRes.data as Array<{
          user_id?: unknown;
          display_name?: unknown;
        }>) {
          if (typeof p.user_id === 'string' && typeof p.display_name === 'string') {
            const trimmed = p.display_name.trim();
            if (trimmed.length > 0) {
              displayMap.set(p.user_id, trimmed);
            }
          }
        }
      }
    }

    const members: CareLogMemberOption[] = memberRows.map((m) => ({
      userId: m.user_id,
      displayName:
        displayMap.get(m.user_id) ?? `${en.circle.defaultMemberName} ${m.user_id.slice(0, 6)}`,
    }));

    let isFamilyPlan = deps.isFamilyPlan ?? false;
    if (deps.isFamilyPlan === undefined) {
      const ownerRow = memberRows.find((m) => m.role === 'owner');
      if (ownerRow?.user_id) {
        try {
          const entRes = await client
            .from('entitlements')
            .select('user_id, entitlement, active, expires_at')
            .eq('user_id', ownerRow.user_id)
            .eq('entitlement', 'carecircle_family')
            .limit(1);
          const ent = Array.isArray(entRes.data)
            ? (entRes.data[0] as { active?: boolean; expires_at?: string | null } | undefined)
            : undefined;
          if (ent?.active === true) {
            const expMs = ent.expires_at ? Date.parse(ent.expires_at) : Number.POSITIVE_INFINITY;
            isFamilyPlan = !Number.isNaN(expMs) && expMs > now.getTime();
          }
        } catch {
          isFamilyPlan = false;
        }
      }
    }

    const { from: defaultFrom, to: defaultTo } = getDefaultExportDateRange(now, timezone);

    return {
      ok: true,
      circleId,
      circleName: rawCircle.name,
      timezone,
      memberRole,
      isFamilyPlan,
      members,
      defaultFrom,
      defaultTo,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, isOffline: isNetworkFailureMessage(msg) };
  }
}

export async function fetchCareLogPage(
  input: {
    circleId: string;
    offset: number;
    limit?: number;
    typeFilter?: LogType | null;
    personFilter?: string | null;
    memberDisplayNames?: ReadonlyMap<string, string>;
  },
  deps: CareLogDeps = {},
): Promise<FetchCareLogPageResult> {
  if (deps.isOffline) {
    return { ok: false, isOffline: true };
  }
  const getClient = deps.getClient ?? getSupabaseClient;
  const limit = input.limit ?? CARE_LOG_PAGE_SIZE;

  try {
    const client = getClient();
    let query = client
      .from('log_entries')
      .select('id, circle_id, type, ref_id, summary, created_by, created_at')
      .eq('circle_id', input.circleId);

    if (input.typeFilter) {
      query = query.eq('type', input.typeFilter);
    }
    if (input.personFilter) {
      query = query.eq('created_by', input.personFilter);
    }

    const res = await query
      .order('created_at', { ascending: false })
      .range(input.offset, input.offset + limit - 1);

    if (res.error || !Array.isArray(res.data)) {
      const errMsg = res.error?.message ?? '';
      return { ok: false, isOffline: isNetworkFailureMessage(errMsg, res.error?.code) };
    }

    const rows = res.data as Array<{
      id: string;
      circle_id: string;
      type: LogType;
      ref_id: string | null;
      summary: string | null;
      created_by: string | null;
      created_at: string;
    }>;

    const entries: CareLogEntryItem[] = rows.map((row) => ({
      id: row.id,
      circleId: row.circle_id,
      type: row.type,
      refId: row.ref_id ?? null,
      summary: row.summary ?? null,
      createdBy: row.created_by ?? null,
      createdAt: row.created_at,
      actorDisplayName: row.created_by
        ? (input.memberDisplayNames?.get(row.created_by) ??
          `${en.circle.defaultMemberName} ${row.created_by.slice(0, 6)}`)
        : en.careLog.actorSystem,
    }));

    return {
      ok: true,
      entries,
      hasMore: entries.length === limit,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, isOffline: isNetworkFailureMessage(msg) };
  }
}

export async function exportCareLogPdf(
  input: {
    circleId: string;
    from: string;
    to: string;
  },
  deps: CareLogDeps = {},
): Promise<ExportCareLogPdfResult> {
  const days = computeExportRangeDays(input.from, input.to);
  if (days === null) {
    return { ok: false, errorCode: 'RANGE_INVALID', isOffline: false };
  }
  if (deps.isOffline) {
    return { ok: false, errorCode: 'NETWORK_ERROR', isOffline: true };
  }

  const getClient = deps.getClient ?? getSupabaseClient;
  const shareUrl =
    deps.shareUrl ??
    (async (pdfUrl: string) => {
      await Share.share({ url: pdfUrl, message: pdfUrl });
    });
  const trackLogExported = deps.trackLogExported ?? defaultTrackLogExported;

  try {
    const client = getClient();
    const res = await client.functions.invoke('export-log', {
      body: {
        circleId: input.circleId,
        from: input.from.trim(),
        to: input.to.trim(),
      },
    });

    const data = res.data as
      | {
          ok?: boolean;
          pdfUrl?: string;
          code?: string;
          error?: { code?: string };
        }
      | null
      | undefined;

    const errCode = data?.code ?? data?.error?.code ?? '';
    if (errCode === 'QUOTA_EXCEEDED' || /QUOTA_EXCEEDED|402/i.test(res.error?.message ?? '')) {
      return { ok: false, errorCode: 'QUOTA_EXCEEDED', isOffline: false };
    }
    if (errCode === 'RANGE_INVALID' || /RANGE_INVALID/i.test(res.error?.message ?? '')) {
      return { ok: false, errorCode: 'RANGE_INVALID', isOffline: false };
    }

    if (res.error || !data?.pdfUrl || typeof data.pdfUrl !== 'string') {
      const offline = isNetworkFailureMessage(res.error?.message ?? '', errCode);
      return {
        ok: false,
        errorCode: offline ? 'NETWORK_ERROR' : 'EXPORT_FAILED',
        isOffline: offline,
      };
    }

    try {
      await shareUrl(data.pdfUrl);
    } catch {
      // Share dismissal should not fail a completed export.
    }

    try {
      trackLogExported(days);
    } catch {
      // Analytics never turns a completed export into an error.
    }

    return {
      ok: true,
      pdfUrl: data.pdfUrl,
      days,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const offline = isNetworkFailureMessage(msg);
    return {
      ok: false,
      errorCode: offline ? 'NETWORK_ERROR' : 'EXPORT_FAILED',
      isOffline: offline,
    };
  }
}
