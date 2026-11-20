import {
  circleRowSchema,
  circleSchema,
  isNetworkFailureMessage,
  type Circle,
  type CircleRow,
} from '@carecircle/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { getSupabaseClient } from '../auth/api';
import { getAppObservability } from '../observability/api';

export function isValidIanaTimezone(timezone: string): boolean {
  const trimmed = timezone.trim();
  if (!trimmed) {
    return false;
  }
  try {
    Intl.DateTimeFormat(undefined, { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

export function resolveDefaultTimezone(
  resolveZone: () => string | undefined = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  try {
    const candidate = resolveZone()?.trim() ?? '';
    if (candidate && isValidIanaTimezone(candidate)) {
      return candidate;
    }
  } catch {
    // Fall back to UTC if the runtime cannot resolve the device timezone.
  }
  return 'UTC';
}

export const FALLBACK_IANA_TIMEZONES: ReadonlyArray<string> = [
  'UTC',
  'Europe/Paris',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Rome',
  'Europe/Brussels',
  'Europe/Zurich',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'America/Vancouver',
  'America/Sao_Paulo',
  'Africa/Tunis',
  'Africa/Casablanca',
  'Africa/Cairo',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Sydney',
  'Pacific/Auckland',
];

type SupportedValuesOfFn = (key: 'timeZone') => string[];

export function getSupportedIanaTimezones(
  deviceTimezone?: string,
  supportedValuesOf?: SupportedValuesOfFn | null,
): string[] {
  const defaultZone =
    deviceTimezone && isValidIanaTimezone(deviceTimezone)
      ? deviceTimezone.trim()
      : resolveDefaultTimezone();

  const intlWithSupported = Intl as unknown as {
    supportedValuesOf?: SupportedValuesOfFn;
  };
  const fn =
    supportedValuesOf === undefined ? intlWithSupported.supportedValuesOf : supportedValuesOf;

  let rawList: ReadonlyArray<string> = FALLBACK_IANA_TIMEZONES;
  if (typeof fn === 'function') {
    try {
      const candidate = fn.call(Intl, 'timeZone');
      if (Array.isArray(candidate) && candidate.length > 0) {
        rawList = candidate;
      }
    } catch {
      rawList = FALLBACK_IANA_TIMEZONES;
    }
  }

  const seen = new Set<string>([defaultZone]);
  const ordered: string[] = [defaultZone];
  for (const tz of rawList) {
    if (typeof tz === 'string') {
      const trimmed = tz.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        ordered.push(trimmed);
      }
    }
  }
  if (!seen.has('UTC')) {
    ordered.push('UTC');
  }
  return ordered;
}

export function filterIanaTimezones(
  query: string,
  deviceTimezone?: string,
  options?: {
    maxResults?: number;
    supportedValuesOf?: SupportedValuesOfFn | null;
  },
): string[] {
  const all = getSupportedIanaTimezones(deviceTimezone, options?.supportedValuesOf);
  const maxResults = options?.maxResults ?? 12;
  const trimmed = query.trim();
  const defaultZone = all[0] ?? 'UTC';

  // When the input is empty or still holds the default/exact selected zone, show the device zone
  // first followed by common zones so the picker offers quick selection alongside search.
  if (!trimmed || trimmed.toLowerCase() === defaultZone.toLowerCase()) {
    const quickSet = new Set<string>([defaultZone]);
    const quickList: string[] = [defaultZone];
    for (const tz of [...FALLBACK_IANA_TIMEZONES, ...all]) {
      if (!quickSet.has(tz) && all.includes(tz)) {
        quickSet.add(tz);
        quickList.push(tz);
        if (quickList.length >= maxResults) break;
      }
    }
    return quickList;
  }

  const needle = trimmed.toLowerCase();
  const matches = all.filter((tz) => tz.toLowerCase().includes(needle));
  return matches.slice(0, maxResults);
}

// Built from the C1 `circleSchema` in `@carecircle/core` plus an IANA timezone check.
export const createCircleFormSchema = circleSchema
  .pick({
    name: true,
    careRecipientName: true,
    timezone: true,
  })
  .extend({
    timezone: circleSchema.shape.timezone.refine(isValidIanaTimezone, {
      message: 'Invalid IANA timezone',
    }),
  })
  .strict();

export type CreateCircleFormValues = z.infer<typeof createCircleFormSchema>;

export type CreateCircleErrorCode =
  | 'VALIDATION_ERROR'
  | 'NETWORK_ERROR'
  | 'CIRCLE_LIMIT_REACHED'
  | 'CIRCLE_LIMIT'
  | 'CREATE_CIRCLE_FAILED';

export type CreateCircleResult =
  | {
      ok: true;
      circle: Circle;
    }
  | {
      ok: false;
      errorCode: CreateCircleErrorCode;
      isOffline: boolean;
    };

export interface CreateCircleDeps {
  getClient?: () => Pick<SupabaseClient, 'rpc'>;
  trackCircleCreated?: () => void;
}

// `snakeToCamel` from core converts one key string, not a whole row, so map the C1 row explicitly.
export function circleFromRow(row: CircleRow): Circle {
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

export async function createCircleViaRpc(
  input: CreateCircleFormValues,
  deps: CreateCircleDeps = {},
): Promise<CreateCircleResult> {
  const parsedInput = createCircleFormSchema.safeParse({
    name: input.name.trim(),
    careRecipientName: input.careRecipientName.trim(),
    timezone: input.timezone.trim(),
  });

  if (!parsedInput.success) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      isOffline: false,
    };
  }

  const getClient = deps.getClient ?? getSupabaseClient;
  const trackCircleCreated =
    deps.trackCircleCreated ??
    (() => {
      // The typed analytics client validates the event: `cc_circle_created` sends no circle or person names.
      void getAppObservability()
        .analytics.track('cc_circle_created', {})
        .catch(() => undefined);
    });

  let rpcData: unknown;
  let rpcError: { message: string; code?: string } | null = null;

  try {
    const client = getClient();
    const response = await client.rpc('create_circle', {
      name: parsedInput.data.name,
      careRecipientName: parsedInput.data.careRecipientName,
      timezone: parsedInput.data.timezone,
    });
    rpcData = response.data;
    rpcError = response.error as { message: string; code?: string } | null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const offline = isNetworkFailureMessage(message);
    return {
      ok: false,
      errorCode: offline ? 'NETWORK_ERROR' : 'CREATE_CIRCLE_FAILED',
      isOffline: offline,
    };
  }

  if (rpcError) {
    // P0001 is Postgres's generic "raise exception" code, so match the message, not the code.
    if (/CIRCLE_LIMIT_REACHED/.test(rpcError.message ?? '')) {
      return {
        ok: false,
        errorCode: 'CIRCLE_LIMIT_REACHED',
        isOffline: false,
      };
    }
    if (/\bCIRCLE_LIMIT\b/.test(rpcError.message ?? '')) {
      return {
        ok: false,
        errorCode: 'CIRCLE_LIMIT',
        isOffline: false,
      };
    }
    const offline = isNetworkFailureMessage(rpcError.message ?? '', rpcError.code);
    return {
      ok: false,
      errorCode: offline ? 'NETWORK_ERROR' : 'CREATE_CIRCLE_FAILED',
      isOffline: offline,
    };
  }

  const rawRow = Array.isArray(rpcData) ? rpcData[0] : rpcData;
  const normalizedRow =
    rawRow && typeof rawRow === 'object' ? { ...(rawRow as Record<string, unknown>) } : null;
  if (normalizedRow && typeof normalizedRow.created_at === 'string') {
    const parsedDate = new Date(normalizedRow.created_at);
    if (!Number.isNaN(parsedDate.getTime())) {
      normalizedRow.created_at = parsedDate.toISOString();
    }
  }

  const rowParsed = circleRowSchema.safeParse(normalizedRow);
  const circleParsed = rowParsed.success
    ? circleSchema.safeParse(circleFromRow(rowParsed.data))
    : rowParsed;

  if (!circleParsed.success) {
    return {
      ok: false,
      errorCode: 'CREATE_CIRCLE_FAILED',
      isOffline: false,
    };
  }

  // Fire `cc_circle_created` once after the RPC succeeds. Analytics errors must not fail the action.
  try {
    trackCircleCreated();
  } catch {
    // Ignored: circle is already created on the server.
  }

  return {
    ok: true,
    circle: circleParsed.data,
  };
}
