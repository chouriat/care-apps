export type PushPlatform = 'ios' | 'android';

export interface PushTokenRegistration {
  token: string;
  platform: PushPlatform;
}

/**
 * Wraps `supabase.rpc('register_push_token', { p_token, p_platform })`.
 * The database takes the user from the session (auth.uid()), never from the app, and moves the
 * token to the caller if another user registered it on this phone before. A plain
 * `.from('push_tokens').upsert()` is refused by the table's grants on purpose.
 */
export interface PushTokenStoreAdapter {
  registerPushToken(
    registration: PushTokenRegistration,
  ): Promise<{ error: { message: string; code?: string } | null }>;
}

export type PushTokenRegistrationInput = PushTokenRegistration;

export interface LocalNotificationRequest {
  identifier?: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  triggerDate: Date;
}

export interface LocalNotificationAdapter {
  scheduleNotificationAsync(request: LocalNotificationRequest): Promise<string>;
  cancelScheduledNotificationAsync(identifier: string): Promise<void>;
}

export interface LocalTimeTriggerInput {
  date: string;
  time: string;
  timeZone: string;
}

export interface LocalTimeTriggerResult {
  triggerDate: Date;
  triggerAtMs: number;
  triggerAtIso: string;
  adjustedLocalTime: string;
}

export interface LocalReminderInput extends LocalTimeTriggerInput {
  title: string;
  body: string;
  identifier?: string;
  data?: Record<string, string>;
}

export interface ScheduledLocalReminder extends LocalTimeTriggerResult {
  notificationId: string;
}

interface LocalWallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
const EXPO_PUSH_TOKEN_REGEX = /^(?:ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/;

export function isValidIanaTimeZone(timeZone: string): boolean {
  if (!timeZone || typeof timeZone !== 'string' || timeZone.trim() !== timeZone) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function parseCalendarDate(dateStr: string): { year: number; month: number; day: number } {
  const match = DATE_REGEX.exec(dateStr);
  if (!match) {
    throw new Error(`Invalid calendar date "${dateStr}"; expected YYYY-MM-DD`);
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
    throw new Error(`Non-existent calendar date "${dateStr}"`);
  }
  return { year, month, day };
}

function parseWallTime(timeStr: string): { hour: number; minute: number } {
  const match = TIME_REGEX.exec(timeStr);
  if (!match) {
    throw new Error(`Invalid local time "${timeStr}"; expected HH:MM (24-hour)`);
  }
  return {
    hour: Number.parseInt(match[1] ?? '', 10),
    minute: Number.parseInt(match[2] ?? '', 10),
  };
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

function formatTwoDigits(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Converts a local calendar date (`YYYY-MM-DD`) and 24-hour wall time (`HH:MM`)
 * in a given IANA timezone into its UTC trigger timestamp.
 *
 * Per Spec Part 2 > Dose engine rule 5:
 * - A local time that does not exist (e.g. 02:30 during DST spring-forward) moves
 *   to the next valid local minute (03:00).
 * - A repeated local time (e.g. 01:30 during DST fall-back) fires once at its
 *   first occurrence.
 */
export function computeUtcTriggerForLocalTime(
  input: LocalTimeTriggerInput,
): LocalTimeTriggerResult {
  const { year, month, day } = parseCalendarDate(input.date);
  const { hour, minute } = parseWallTime(input.time);
  if (!isValidIanaTimeZone(input.timeZone)) {
    throw new Error(`Invalid IANA timezone "${input.timeZone}"`);
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: input.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const targetParts: LocalWallParts = { year, month, day, hour, minute };
  const targetKey = wallPartsKey(targetParts);

  // Estimate offset using noon UTC on the target date.
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
  const approxUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0) - approxOffsetMs;

  const approxParts = extractLocalParts(formatter, approxUtcMs);
  if (wallPartsKey(approxParts) === targetKey) {
    // Check if an earlier occurrence exists (DST fall-back 60-min or 30-min overlap).
    for (const shiftMinutes of [60, 30]) {
      const earlierMs = approxUtcMs - shiftMinutes * 60_000;
      if (wallPartsKey(extractLocalParts(formatter, earlierMs)) === targetKey) {
        const triggerDate = new Date(earlierMs);
        return {
          triggerDate,
          triggerAtMs: earlierMs,
          triggerAtIso: triggerDate.toISOString(),
          adjustedLocalTime: `${formatTwoDigits(hour)}:${formatTwoDigits(minute)}`,
        };
      }
    }
    const triggerDate = new Date(approxUtcMs);
    return {
      triggerDate,
      triggerAtMs: approxUtcMs,
      triggerAtIso: triggerDate.toISOString(),
      adjustedLocalTime: `${formatTwoDigits(hour)}:${formatTwoDigits(minute)}`,
    };
  }

  // DST transition window: scan minute-by-minute across [-180m, +180m] around the estimate
  // and select the first UTC minute whose local wall time is >= the requested wall time.
  const windowStartMs = approxUtcMs - 180 * 60_000;
  const windowEndMs = approxUtcMs + 180 * 60_000;
  for (let probeMs = windowStartMs; probeMs <= windowEndMs; probeMs += 60_000) {
    const parts = extractLocalParts(formatter, probeMs);
    if (wallPartsKey(parts) >= targetKey) {
      const triggerDate = new Date(probeMs);
      return {
        triggerDate,
        triggerAtMs: probeMs,
        triggerAtIso: triggerDate.toISOString(),
        adjustedLocalTime: `${formatTwoDigits(parts.hour)}:${formatTwoDigits(parts.minute)}`,
      };
    }
  }

  throw new Error(
    `Could not resolve UTC trigger for ${input.date} ${input.time} in ${input.timeZone}`,
  );
}

export async function scheduleLocalReminder(
  adapter: LocalNotificationAdapter,
  input: LocalReminderInput,
): Promise<ScheduledLocalReminder> {
  if (!input.title.trim() || !input.body.trim()) {
    throw new Error('Notification title and body must be non-empty');
  }
  const resolved = computeUtcTriggerForLocalTime({
    date: input.date,
    time: input.time,
    timeZone: input.timeZone,
  });
  const notificationId = await adapter.scheduleNotificationAsync({
    identifier: input.identifier,
    title: input.title,
    body: input.body,
    data: input.data,
    triggerDate: resolved.triggerDate,
  });
  return {
    ...resolved,
    notificationId,
  };
}

export async function registerPushToken(
  store: PushTokenStoreAdapter,
  input: PushTokenRegistrationInput,
): Promise<PushTokenRegistration> {
  const token = input.token.trim();
  if (!EXPO_PUSH_TOKEN_REGEX.test(token)) {
    throw new Error('Invalid Expo push token format');
  }
  if (input.platform !== 'ios' && input.platform !== 'android') {
    throw new Error('Push platform must be ios or android');
  }

  const row: PushTokenRegistration = { token, platform: input.platform };

  const { error } = await store.registerPushToken(row);
  if (error) {
    throw new Error(`Push token registration failed (${error.code ?? 'DB_ERROR'})`);
  }
  return row;
}
