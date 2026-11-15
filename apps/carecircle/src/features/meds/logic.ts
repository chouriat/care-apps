export type DoseWeekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export type DoseMedicationSchedule =
  | {
      kind: 'daily';
      times: string[];
    }
  | {
      kind: 'weekly';
      days: DoseWeekday[];
      times: string[];
    }
  | {
      kind: 'every_n_days';
      n: number;
      times: string[];
    }
  | {
      kind: 'as_needed';
    };

export interface DoseGeneratorMedication {
  id: string;
  circleId: string;
  schedule: DoseMedicationSchedule;
  startDate: string | null;
  endDate: string | null;
  active: boolean;
}

export interface MaterializedDoseSlot {
  medicationId: string;
  circleId: string;
  dueAt: string;
  localDate: string;
  requestedTime: string;
  adjustedLocalTime: string;
}

interface LocalWallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const ISO_DATE_REGEX = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME_24H_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WEEKDAY_BY_UTC_DAY: readonly DoseWeekday[] = [
  'sun',
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
];
const VALID_WEEKDAYS: ReadonlySet<string> = new Set(WEEKDAY_BY_UTC_DAY);
const MS_PER_CALENDAR_DAY = 86_400_000;

function formatTwoDigits(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatCalendarDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${formatTwoDigits(month)}-${formatTwoDigits(day)}`;
}

function parseCalendarDate(dateStr: string): {
  year: number;
  month: number;
  day: number;
  utcDayNumber: number;
} {
  const match = ISO_DATE_REGEX.exec(dateStr);
  if (!match) {
    throw new Error(`Invalid calendar date "${dateStr}"; expected YYYY-MM-DD`);
  }
  const year = Number.parseInt(match[1] ?? '', 10);
  const month = Number.parseInt(match[2] ?? '', 10);
  const day = Number.parseInt(match[3] ?? '', 10);
  const utcMidnightMs = Date.UTC(year, month - 1, day);
  const probe = new Date(utcMidnightMs);
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() + 1 !== month ||
    probe.getUTCDate() !== day
  ) {
    throw new Error(`Non-existent calendar date "${dateStr}"`);
  }
  return {
    year,
    month,
    day,
    utcDayNumber: Math.round(utcMidnightMs / MS_PER_CALENDAR_DAY),
  };
}

function calendarDateFromUtcDayNumber(utcDayNumber: number): string {
  const dt = new Date(utcDayNumber * MS_PER_CALENDAR_DAY);
  return formatCalendarDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function weekdayForUtcDayNumber(utcDayNumber: number): DoseWeekday {
  const dt = new Date(utcDayNumber * MS_PER_CALENDAR_DAY);
  return WEEKDAY_BY_UTC_DAY[dt.getUTCDay()] ?? 'sun';
}

function parseWallTime(timeStr: string): { hour: number; minute: number } {
  const match = TIME_24H_REGEX.exec(timeStr);
  if (!match) {
    throw new Error(`Invalid 24-hour time "${timeStr}"; expected HH:MM`);
  }
  return {
    hour: Number.parseInt(match[1] ?? '', 10),
    minute: Number.parseInt(match[2] ?? '', 10),
  };
}

export function validateMedicationSchedule(raw: unknown): DoseMedicationSchedule {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Medication schedule must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj);
  const kind = obj.kind;

  const assertTimes = (timesRaw: unknown): string[] => {
    if (!Array.isArray(timesRaw) || timesRaw.length === 0) {
      throw new Error('Medication schedule times must be a non-empty array');
    }
    const validated: string[] = [];
    for (const item of timesRaw) {
      if (typeof item !== 'string' || !TIME_24H_REGEX.test(item)) {
        throw new Error(`Invalid schedule time "${String(item)}"`);
      }
      validated.push(item);
    }
    return validated;
  };

  if (kind === 'as_needed') {
    if (keys.some((k) => k !== 'kind')) {
      throw new Error('as_needed schedule must not contain extra keys');
    }
    return { kind: 'as_needed' };
  }

  if (kind === 'daily') {
    if (keys.some((k) => k !== 'kind' && k !== 'times')) {
      throw new Error('daily schedule must only contain kind and times');
    }
    return { kind: 'daily', times: assertTimes(obj.times) };
  }

  if (kind === 'weekly') {
    if (keys.some((k) => k !== 'kind' && k !== 'days' && k !== 'times')) {
      throw new Error('weekly schedule must only contain kind, days, and times');
    }
    if (!Array.isArray(obj.days) || obj.days.length === 0) {
      throw new Error('weekly schedule days must be a non-empty array');
    }
    const days: DoseWeekday[] = [];
    for (const d of obj.days) {
      if (typeof d !== 'string' || !VALID_WEEKDAYS.has(d)) {
        throw new Error(`Invalid weekday "${String(d)}" in weekly schedule`);
      }
      days.push(d as DoseWeekday);
    }
    return { kind: 'weekly', days, times: assertTimes(obj.times) };
  }

  if (kind === 'every_n_days') {
    if (keys.some((k) => k !== 'kind' && k !== 'n' && k !== 'times')) {
      throw new Error('every_n_days schedule must only contain kind, n, and times');
    }
    if (typeof obj.n !== 'number' || !Number.isInteger(obj.n) || obj.n < 1) {
      throw new Error(`Invalid every_n_days interval "${String(obj.n)}"`);
    }
    return { kind: 'every_n_days', n: obj.n, times: assertTimes(obj.times) };
  }

  throw new Error(`Unsupported medication schedule kind "${String(kind)}"`);
}

function createZoneFormatter(timeZone: string): Intl.DateTimeFormat {
  if (!timeZone || typeof timeZone !== 'string' || timeZone.trim() !== timeZone) {
    throw new Error(`Invalid IANA timezone "${String(timeZone)}"`);
  }
  try {
    return new Intl.DateTimeFormat('en-US', {
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
    throw new Error(`Unknown IANA timezone "${timeZone}"`);
  }
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

function resolveLocalDateTimeToUtc(
  formatter: Intl.DateTimeFormat,
  localDate: string,
  requestedTime: string,
): { dueAtMs: number; adjustedLocalTime: string } {
  const { year, month, day } = parseCalendarDate(localDate);
  const { hour, minute } = parseWallTime(requestedTime);
  const targetKey = wallPartsKey({ year, month, day, hour, minute });

  // Estimate offset using noon UTC on the target civil date.
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
    // DST fall-back check: if the same local wall time occurred 60 or 30 minutes earlier, pick the earliest instant.
    for (const shiftMinutes of [60, 30]) {
      const earlierMs = approxUtcMs - shiftMinutes * 60_000;
      if (wallPartsKey(extractLocalParts(formatter, earlierMs)) === targetKey) {
        return {
          dueAtMs: earlierMs,
          adjustedLocalTime: `${formatTwoDigits(hour)}:${formatTwoDigits(minute)}`,
        };
      }
    }
    return {
      dueAtMs: approxUtcMs,
      adjustedLocalTime: `${formatTwoDigits(hour)}:${formatTwoDigits(minute)}`,
    };
  }

  // DST transition day: scan minute-by-minute across [-180m, +180m] around the estimate.
  // Pass 1: find the earliest exact match if the wall time exists.
  const scanStartMs = approxUtcMs - 180 * 60_000;
  const scanEndMs = approxUtcMs + 180 * 60_000;
  let firstAfterGap: { dueAtMs: number; adjustedLocalTime: string } | null = null;

  for (let probeMs = scanStartMs; probeMs <= scanEndMs; probeMs += 60_000) {
    const parts = extractLocalParts(formatter, probeMs);
    const key = wallPartsKey(parts);
    if (key === targetKey) {
      return {
        dueAtMs: probeMs,
        adjustedLocalTime: `${formatTwoDigits(parts.hour)}:${formatTwoDigits(parts.minute)}`,
      };
    }
    if (firstAfterGap === null && key > targetKey) {
      firstAfterGap = {
        dueAtMs: probeMs,
        adjustedLocalTime: `${formatTwoDigits(parts.hour)}:${formatTwoDigits(parts.minute)}`,
      };
    }
  }

  if (firstAfterGap !== null) {
    return firstAfterGap;
  }

  throw new Error(`Could not resolve local time ${localDate} ${requestedTime} in timezone`);
}

function toTimestampMs(value: Date | string, label: string): number {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid ${label} timestamp`);
  }
  return ms;
}

export function materializeDoseTimes(
  medication: DoseGeneratorMedication,
  circleTimezone: string,
  windowStart: Date | string,
  windowEnd: Date | string,
): MaterializedDoseSlot[] {
  const formatter = createZoneFormatter(circleTimezone);
  const startMs = toTimestampMs(windowStart, 'windowStart');
  const endMs = toTimestampMs(windowEnd, 'windowEnd');

  const schedule = validateMedicationSchedule(medication.schedule);
  const startDateInfo =
    medication.startDate !== null ? parseCalendarDate(medication.startDate) : null;
  const endDateInfo = medication.endDate !== null ? parseCalendarDate(medication.endDate) : null;

  if (schedule.kind === 'every_n_days' && startDateInfo === null) {
    throw new Error('every_n_days medication requires a non-null startDate');
  }

  if (endMs < startMs || !medication.active || schedule.kind === 'as_needed') {
    return [];
  }

  const windowStartLocal = extractLocalParts(formatter, startMs);
  const windowEndLocal = extractLocalParts(formatter, endMs);

  const firstLocalDay =
    parseCalendarDate(
      formatCalendarDate(windowStartLocal.year, windowStartLocal.month, windowStartLocal.day),
    ).utcDayNumber - 1;
  const lastLocalDay =
    parseCalendarDate(
      formatCalendarDate(windowEndLocal.year, windowEndLocal.month, windowEndLocal.day),
    ).utcDayNumber + 1;

  const uniqueTimes = Array.from(new Set(schedule.times)).sort();
  const seenDueAt = new Set<string>();
  const slots: Array<{ dueAtMs: number; slot: MaterializedDoseSlot }> = [];

  for (let dayNum = firstLocalDay; dayNum <= lastLocalDay; dayNum += 1) {
    if (startDateInfo !== null && dayNum < startDateInfo.utcDayNumber) {
      continue;
    }
    if (endDateInfo !== null && dayNum > endDateInfo.utcDayNumber) {
      continue;
    }

    if (schedule.kind === 'weekly') {
      const weekday = weekdayForUtcDayNumber(dayNum);
      if (!schedule.days.includes(weekday)) {
        continue;
      }
    } else if (schedule.kind === 'every_n_days') {
      const diffDays = dayNum - (startDateInfo?.utcDayNumber ?? 0);
      if (diffDays < 0 || diffDays % schedule.n !== 0) {
        continue;
      }
    }

    const localDate = calendarDateFromUtcDayNumber(dayNum);

    for (const requestedTime of uniqueTimes) {
      const { dueAtMs, adjustedLocalTime } = resolveLocalDateTimeToUtc(
        formatter,
        localDate,
        requestedTime,
      );
      if (dueAtMs < startMs || dueAtMs > endMs) {
        continue;
      }
      const dueAt = new Date(dueAtMs).toISOString();
      if (seenDueAt.has(dueAt)) {
        continue;
      }
      seenDueAt.add(dueAt);
      slots.push({
        dueAtMs,
        slot: {
          medicationId: medication.id,
          circleId: medication.circleId,
          dueAt,
          localDate,
          requestedTime,
          adjustedLocalTime,
        },
      });
    }
  }

  slots.sort((a, b) => a.dueAtMs - b.dueAtMs);
  return slots.map((entry) => entry.slot);
}
