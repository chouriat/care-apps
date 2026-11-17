import {
  createPostgrestCircleEntitlementStore,
  verifyCircleFamilyEntitlement,
  type CircleOwnerLookupStore,
  type ServerEntitlementVerification,
} from '../_shared/entitlements.ts';
import { buildCareLogPdf, type CareLogPdfEntry } from './pdf.ts';

export type ExportLogErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'QUOTA_EXCEEDED'
  | 'RANGE_INVALID'
  | 'INPUT_INVALID'
  | 'INTERNAL_ERROR';

export interface CircleMetadataRow {
  id: string;
  name: string;
  care_recipient_name: string;
  timezone: string;
}

export interface LogEntryRow {
  id: string;
  circle_id: string;
  type: string;
  ref_id: string | null;
  summary: string | null;
  created_by: string | null;
  created_at: string;
}

export interface ExportLogStore {
  isCircleMember(userId: string, circleId: string): Promise<boolean>;
  getCircle(circleId: string): Promise<CircleMetadataRow | null>;
  listLogEntries(opts: {
    circleId: string;
    fromUtcIso: string;
    toExclusiveUtcIso: string;
  }): Promise<LogEntryRow[]>;
  getDisplayNames(userIds: string[]): Promise<Record<string, string>>;
}

export interface ExportLogStorage {
  uploadPdf(opts: { path: string; bytes: Uint8Array }): Promise<void>;
  createSignedUrl(opts: { path: string; expiresIn: number }): Promise<string>;
}

export interface ExportLogAuditEvent {
  circleId: string;
  exportId: string;
  entryCount: number;
}

export interface ExportLogDeps {
  verifyJwt?: (token: string) => Promise<{ userId: string } | null>;
  store?: ExportLogStore;
  storage?: ExportLogStorage;
  entitlementStore?: CircleOwnerLookupStore;
  checkCircleFamilyEntitlement?: (opts: {
    circleId: string;
    now: Date;
  }) => Promise<ServerEntitlementVerification>;
  fetchImpl?: typeof fetch;
  getEnv?: (key: string) => string | undefined;
  now?: () => Date;
  randomUuid?: () => string;
  onLogExported?: (event: ExportLogAuditEvent) => void;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_ONLY_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_EXPORT_DAYS = 90;
const SIGNED_URL_EXPIRES_IN_SECONDS = 3600;
const PAGE_SIZE = 500;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const fail = (code: ExportLogErrorCode, message: string, status: number): Response =>
  json({ ok: false, code, error: { code, message } }, status);

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

export function validateDateRange(
  from: unknown,
  to: unknown,
):
  | { ok: true; from: string; to: string; inclusiveDays: number; nextDayAfterTo: string }
  | { ok: false } {
  if (typeof from !== 'string' || typeof to !== 'string') {
    return { ok: false };
  }
  const fromTrimmed = from.trim();
  const toTrimmed = to.trim();
  const fromMs = parseCalendarDateUtcMs(fromTrimmed);
  const toMs = parseCalendarDateUtcMs(toTrimmed);
  if (fromMs === null || toMs === null) {
    return { ok: false };
  }
  if (fromMs > toMs) {
    return { ok: false };
  }
  const inclusiveDays = Math.round((toMs - fromMs) / 86_400_000) + 1;
  if (inclusiveDays < 1 || inclusiveDays > MAX_EXPORT_DAYS) {
    return { ok: false };
  }
  const nextDayAfterTo = formatUtcMsAsDateOnly(toMs + 86_400_000);
  return {
    ok: true,
    from: fromTrimmed,
    to: toTrimmed,
    inclusiveDays,
    nextDayAfterTo,
  };
}

export function resolveLocalMidnightInZoneToUtcIso(dateStr: string, timeZone: string): string {
  const match = DATE_ONLY_REGEX.exec(dateStr);
  if (!match) {
    return `${dateStr}T00:00:00.000Z`;
  }
  const year = Number.parseInt(match[1] ?? '1970', 10);
  const month = Number.parseInt(match[2] ?? '1', 10);
  const day = Number.parseInt(match[3] ?? '1', 10);
  const targetUtcMidnight = Date.UTC(year, month - 1, day, 0, 0, 0, 0);

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    return new Date(targetUtcMidnight).toISOString();
  }

  const getLocalWallMs = (utcMs: number): number => {
    const parts = formatter.formatToParts(new Date(utcMs));
    const y = Number.parseInt(parts.find((p) => p.type === 'year')?.value ?? '1970', 10);
    const m = Number.parseInt(parts.find((p) => p.type === 'month')?.value ?? '1', 10);
    const d = Number.parseInt(parts.find((p) => p.type === 'day')?.value ?? '1', 10);
    const hRaw = Number.parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
    const min = Number.parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
    const sec = Number.parseInt(parts.find((p) => p.type === 'second')?.value ?? '0', 10);
    const h = hRaw === 24 ? 0 : hRaw;
    return Date.UTC(y, m - 1, d, h, min, sec, 0);
  };

  let guess = targetUtcMidnight;
  for (let i = 0; i < 3; i += 1) {
    const diff = getLocalWallMs(guess) - targetUtcMidnight;
    if (diff === 0) break;
    guess -= diff;
  }
  return new Date(guess).toISOString();
}

function createDefaultVerifyJwt(
  fetchImpl: typeof fetch,
  getEnv: (key: string) => string | undefined,
) {
  return async (token: string): Promise<{ userId: string } | null> => {
    const url = getEnv('SUPABASE_URL');
    const apikey = getEnv('SUPABASE_ANON_KEY');
    if (!url || !apikey) return null;
    const res = await fetchImpl(`${url}/auth/v1/user`, {
      headers: { authorization: `Bearer ${token}`, apikey },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { id?: unknown };
    return typeof data?.id === 'string' ? { userId: data.id } : null;
  };
}

export function createPostgrestExportLogStore(
  fetchImpl: typeof fetch,
  getEnv: (key: string) => string | undefined,
): ExportLogStore {
  const getCredentials = () => {
    const url = getEnv('SUPABASE_URL');
    const apikey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !apikey) {
      throw new Error('export-log store not configured');
    }
    return { url, apikey };
  };

  return {
    async isCircleMember(userId: string, circleId: string): Promise<boolean> {
      const { url, apikey } = getCredentials();
      const query = `circle_id=eq.${encodeURIComponent(circleId)}&user_id=eq.${encodeURIComponent(userId)}&select=role&limit=1`;
      const res = await fetchImpl(`${url}/rest/v1/circle_members?${query}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${apikey}`, apikey },
      });
      if (!res.ok) {
        throw new Error(`circle_members lookup failed: ${res.status}`);
      }
      const rows = (await res.json()) as Array<{ role?: unknown }>;
      return (
        Array.isArray(rows) &&
        rows.some((r) => r.role === 'owner' || r.role === 'helper' || r.role === 'viewer')
      );
    },

    async getCircle(circleId: string): Promise<CircleMetadataRow | null> {
      const { url, apikey } = getCredentials();
      const query = `id=eq.${encodeURIComponent(circleId)}&select=id,name,care_recipient_name,timezone&limit=1`;
      const res = await fetchImpl(`${url}/rest/v1/circles?${query}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${apikey}`, apikey },
      });
      if (!res.ok) {
        throw new Error(`circles lookup failed: ${res.status}`);
      }
      const rows = (await res.json()) as CircleMetadataRow[];
      return Array.isArray(rows) && rows[0] ? rows[0] : null;
    },

    async listLogEntries({ circleId, fromUtcIso, toExclusiveUtcIso }): Promise<LogEntryRow[]> {
      const { url, apikey } = getCredentials();
      const all: LogEntryRow[] = [];
      let offset = 0;
      while (true) {
        const query =
          `circle_id=eq.${encodeURIComponent(circleId)}` +
          `&created_at=gte.${encodeURIComponent(fromUtcIso)}` +
          `&created_at=lt.${encodeURIComponent(toExclusiveUtcIso)}` +
          `&select=id,circle_id,type,ref_id,summary,created_by,created_at` +
          `&order=created_at.desc,id.desc` +
          `&limit=${PAGE_SIZE}&offset=${offset}`;
        const res = await fetchImpl(`${url}/rest/v1/log_entries?${query}`, {
          method: 'GET',
          headers: { authorization: `Bearer ${apikey}`, apikey },
        });
        if (!res.ok) {
          throw new Error(`log_entries lookup failed: ${res.status}`);
        }
        const page = (await res.json()) as LogEntryRow[];
        if (!Array.isArray(page) || page.length === 0) {
          break;
        }
        all.push(...page);
        if (page.length < PAGE_SIZE) {
          break;
        }
        offset += PAGE_SIZE;
      }
      return all;
    },

    async getDisplayNames(userIds: string[]): Promise<Record<string, string>> {
      const uniqueIds = Array.from(new Set(userIds.filter((id) => UUID_REGEX.test(id))));
      if (uniqueIds.length === 0) return {};
      const { url, apikey } = getCredentials();
      const inList = uniqueIds.map((id) => encodeURIComponent(id)).join(',');
      const query = `user_id=in.(${inList})&select=user_id,display_name`;
      const res = await fetchImpl(`${url}/rest/v1/users_profile?${query}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${apikey}`, apikey },
      });
      if (!res.ok) {
        throw new Error(`users_profile lookup failed: ${res.status}`);
      }
      const rows = (await res.json()) as Array<{ user_id?: unknown; display_name?: unknown }>;
      const result: Record<string, string> = {};
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (
            typeof row.user_id === 'string' &&
            typeof row.display_name === 'string' &&
            row.display_name.trim().length > 0
          ) {
            result[row.user_id] = row.display_name.trim();
          }
        }
      }
      return result;
    },
  };
}

export function createSupabaseExportLogStorage(
  fetchImpl: typeof fetch,
  getEnv: (key: string) => string | undefined,
): ExportLogStorage {
  const getCredentials = () => {
    const url = getEnv('SUPABASE_URL');
    const apikey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !apikey) {
      throw new Error('export-log storage not configured');
    }
    return { url, apikey };
  };

  return {
    async uploadPdf({ path, bytes }): Promise<void> {
      const { url, apikey } = getCredentials();
      const res = await fetchImpl(`${url}/storage/v1/object/log-exports/${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apikey}`,
          apikey,
          'content-type': 'application/pdf',
          'x-upsert': 'false',
        },
        body: bytes as unknown as BodyInit,
      });
      if (!res.ok) {
        throw new Error(`log-exports upload failed: ${res.status}`);
      }
    },

    async createSignedUrl({ path, expiresIn }): Promise<string> {
      const { url, apikey } = getCredentials();
      const res = await fetchImpl(`${url}/storage/v1/object/sign/log-exports/${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apikey}`,
          apikey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ expiresIn }),
      });
      if (!res.ok) {
        throw new Error(`log-exports sign failed: ${res.status}`);
      }
      const payload = (await res.json()) as { signedURL?: unknown; signedUrl?: unknown };
      const rawSigned =
        typeof payload.signedURL === 'string'
          ? payload.signedURL
          : typeof payload.signedUrl === 'string'
            ? payload.signedUrl
            : '';
      if (!rawSigned) {
        throw new Error('log-exports sign returned no URL');
      }
      if (rawSigned.startsWith('http://') || rawSigned.startsWith('https://')) {
        return rawSigned;
      }
      const normalized = rawSigned.startsWith('/storage/v1')
        ? rawSigned
        : `/storage/v1${rawSigned.startsWith('/') ? '' : '/'}${rawSigned}`;
      return `${url}${normalized}`;
    },
  };
}

export function createExportLogHandler(deps: ExportLogDeps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const getEnv = deps.getEnv ?? ((key: string) => Deno.env.get(key));
  const now = deps.now ?? (() => new Date());
  const randomUuid = deps.randomUuid ?? (() => crypto.randomUUID());
  const verifyJwt = deps.verifyJwt ?? createDefaultVerifyJwt(fetchImpl, getEnv);
  const store = deps.store ?? createPostgrestExportLogStore(fetchImpl, getEnv);
  const storage = deps.storage ?? createSupabaseExportLogStorage(fetchImpl, getEnv);
  const entitlementStore =
    deps.entitlementStore ?? createPostgrestCircleEntitlementStore(fetchImpl, getEnv);
  const checkCircleFamilyEntitlement =
    deps.checkCircleFamilyEntitlement ??
    (({ circleId, now: checkNow }: { circleId: string; now: Date }) =>
      verifyCircleFamilyEntitlement({ circleId, store: entitlementStore, now: checkNow }));
  const onLogExported =
    deps.onLogExported ??
    ((event: ExportLogAuditEvent) => {
      // Log only counts and IDs, never PDF content or care recipient name.
      console.info(
        JSON.stringify({
          event: 'carecircle.export_log',
          circleId: event.circleId,
          exportId: event.exportId,
          entryCount: event.entryCount,
        }),
      );
    });

  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') {
      return fail('INPUT_INVALID', 'Method not allowed.', 405);
    }

    const match = /^Bearer\s+(.+)$/i.exec((req.headers.get('authorization') ?? '').trim());
    if (!match?.[1]) {
      return fail('UNAUTHENTICATED', 'Missing or invalid authorization token.', 401);
    }

    let authUser: { userId: string } | null = null;
    try {
      authUser = await verifyJwt(match[1]);
    } catch {
      authUser = null;
    }
    if (!authUser?.userId) {
      return fail('UNAUTHENTICATED', 'Missing or invalid authorization token.', 401);
    }

    let rawBody: Record<string, unknown>;
    try {
      const parsed = await req.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return fail('INPUT_INVALID', 'Invalid request body.', 400);
      }
      rawBody = parsed as Record<string, unknown>;
    } catch {
      return fail('INPUT_INVALID', 'Invalid JSON body.', 400);
    }

    const circleId = typeof rawBody.circleId === 'string' ? rawBody.circleId.trim() : '';
    if (!UUID_REGEX.test(circleId)) {
      return fail('INPUT_INVALID', 'Invalid circleId.', 400);
    }

    // 1. Caller must be a member of that circle (any role: owner, helper, viewer); otherwise 403 with no detail.
    let isMember = false;
    try {
      isMember = await store.isCircleMember(authUser.userId, circleId);
    } catch {
      return fail('INTERNAL_ERROR', 'Unable to verify circle membership.', 500);
    }
    if (!isMember) {
      return new Response(JSON.stringify({ ok: false, error: { code: 'FORBIDDEN' } }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    }

    // 2. Family plan check (via server-side owner entitlement only, ignoring any client body fields)
    // BEFORE reading any circle data or log entries.
    const entitlementResult = await checkCircleFamilyEntitlement({
      circleId,
      now: now(),
    });
    if (!entitlementResult.allowed) {
      if (entitlementResult.reason === 'STORE_ERROR') {
        return fail('INTERNAL_ERROR', 'Unable to verify circle plan.', 500);
      }
      return fail('QUOTA_EXCEEDED', 'Family plan required to export care log PDF.', 402);
    }

    // 3. Date range check: `from` not after `to`, inclusive span <= 90 days.
    const rangeResult = validateDateRange(rawBody.from, rawBody.to);
    if (!rangeResult.ok) {
      return fail(
        'RANGE_INVALID',
        'Date range must be valid YYYY-MM-DD with from <= to and at most 90 days.',
        400,
      );
    }

    // 4. Fetch circle metadata, log entries, and actor display names.
    try {
      const circle = await store.getCircle(circleId);
      if (!circle) {
        return new Response(JSON.stringify({ ok: false, error: { code: 'FORBIDDEN' } }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      }

      const fromUtcIso = resolveLocalMidnightInZoneToUtcIso(rangeResult.from, circle.timezone);
      const toExclusiveUtcIso = resolveLocalMidnightInZoneToUtcIso(
        rangeResult.nextDayAfterTo,
        circle.timezone,
      );

      const logRows = await store.listLogEntries({
        circleId,
        fromUtcIso,
        toExclusiveUtcIso,
      });

      const actorIds = logRows
        .map((r) => r.created_by)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      const displayNames = await store.getDisplayNames(actorIds);

      const pdfEntries: CareLogPdfEntry[] = logRows.map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        type: row.type,
        summary: row.summary,
        actorDisplay: row.created_by
          ? (displayNames[row.created_by] ?? `Member ${row.created_by.slice(0, 8)}`)
          : 'System',
      }));

      const pdfBytes = await buildCareLogPdf({
        circleName: circle.name,
        careRecipientName: circle.care_recipient_name,
        timezone: circle.timezone,
        from: rangeResult.from,
        to: rangeResult.to,
        entries: pdfEntries,
      });

      const exportId = randomUuid();
      const objectPath = `${circleId}/${exportId}.pdf`;
      await storage.uploadPdf({ path: objectPath, bytes: pdfBytes });
      const pdfUrl = await storage.createSignedUrl({
        path: objectPath,
        expiresIn: SIGNED_URL_EXPIRES_IN_SECONDS,
      });

      onLogExported({
        circleId,
        exportId,
        entryCount: pdfEntries.length,
      });

      return json({ ok: true, pdfUrl }, 200);
    } catch {
      return fail('INTERNAL_ERROR', 'Failed to export care log PDF.', 500);
    }
  };
}
