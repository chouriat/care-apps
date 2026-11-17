export type MemberRoleMetric = 'owner' | 'helper' | 'viewer';
export type MedAddedSourceMetric = 'manual' | 'photo';
export type DoseActionStatusMetric = 'given' | 'skipped';
export type PaywallTriggerMetric = 'member_limit' | 'visit_note_ai' | 'pdf_export' | 'settings';
export type EntitlementMetric = 'carecircle_family';

/**
 * Strictly typed CareCircle analytics event catalog (`docs/spec/carecircle.md` > Analytics & Analytics events).
 *
 * Rules enforced at both compile time and runtime:
 * - Event names are `snake_case`, past tense, prefixed `cc_`.
 * - Properties are counts (non-negative integers) and fixed enums only.
 * - Health details, medication names, emails, tokens, and free text are forbidden.
 */
export interface CareCircleAnalyticsEventMap {
  cc_circle_created: {
    memberCount?: number;
  };
  cc_invite_sent: {
    role?: MemberRoleMetric;
  };
  cc_invite_accepted: {
    role?: MemberRoleMetric;
  };
  cc_med_added: {
    source: MedAddedSourceMetric;
    scheduleCount?: number;
  };
  cc_dose_given: {
    status?: DoseActionStatusMetric;
  };
  cc_dose_missed: {
    missedCount?: number;
  };
  cc_visit_note_saved: {
    followUps?: number;
    medChanges?: number;
    followUpCount?: number;
    medChangeCount?: number;
    questionCount?: number;
  };
  cc_log_exported: {
    daySpan?: number;
    entryCount?: number;
  };
  cc_paywall_viewed: {
    trigger?: PaywallTriggerMetric;
  };
  cc_trial_started: {
    entitlement?: EntitlementMetric;
  };
}

export type CareCircleEventName = keyof CareCircleAnalyticsEventMap;

export type ExactProperties<Provided, Allowed> = Provided extends Allowed
  ? Exclude<keyof Provided, keyof Allowed> extends never
    ? Provided
    : Allowed & Record<Exclude<keyof Provided, keyof Allowed>, never>
  : Allowed;

type RequiredKeysOf<T> = {
  [K in keyof T]-?: undefined extends T[K] ? never : K;
}[keyof T];

export type EventRequiresProperties<E extends CareCircleEventName> =
  RequiredKeysOf<CareCircleAnalyticsEventMap[E]> extends never ? false : true;

type PropertyRule =
  | {
      kind: 'enum';
      required: boolean;
      values: readonly string[];
    }
  | {
      kind: 'count';
      required: boolean;
    };

const EVENT_PROPERTY_RULES: {
  readonly [E in CareCircleEventName]: Readonly<Record<string, PropertyRule>>;
} = {
  cc_circle_created: {
    memberCount: { kind: 'count', required: false },
  },
  cc_invite_sent: {
    role: { kind: 'enum', required: false, values: ['owner', 'helper', 'viewer'] },
  },
  cc_invite_accepted: {
    role: { kind: 'enum', required: false, values: ['owner', 'helper', 'viewer'] },
  },
  cc_med_added: {
    source: { kind: 'enum', required: true, values: ['manual', 'photo'] },
    scheduleCount: { kind: 'count', required: false },
  },
  cc_dose_given: {
    status: { kind: 'enum', required: false, values: ['given', 'skipped'] },
  },
  cc_dose_missed: {
    missedCount: { kind: 'count', required: false },
  },
  cc_visit_note_saved: {
    followUps: { kind: 'count', required: false },
    medChanges: { kind: 'count', required: false },
    followUpCount: { kind: 'count', required: false },
    medChangeCount: { kind: 'count', required: false },
    questionCount: { kind: 'count', required: false },
  },
  cc_log_exported: {
    daySpan: { kind: 'count', required: false },
    entryCount: { kind: 'count', required: false },
  },
  cc_paywall_viewed: {
    trigger: {
      kind: 'enum',
      required: false,
      values: ['member_limit', 'visit_note_ai', 'pdf_export', 'settings'],
    },
  },
  cc_trial_started: {
    entitlement: { kind: 'enum', required: false, values: ['carecircle_family'] },
  },
};

export const ALLOWED_ANALYTICS_EVENTS = Object.freeze(
  Object.keys(EVENT_PROPERTY_RULES) as CareCircleEventName[],
);

export class AnalyticsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyticsValidationError';
  }
}

export interface PostHogAdapter {
  capture(event: string, properties?: Record<string, string | number>): void | Promise<void>;
}

export interface AnalyticsClientOptions {
  /**
   * When true (`__DEV__`), invalid events throw `AnalyticsValidationError` immediately.
   * When false (production), invalid events are dropped and reported once via `onValidationError`.
   */
  isDev?: boolean;
  onValidationError?: (error: AnalyticsValidationError) => void;
}

export interface AnalyticsClient {
  track<
    E extends CareCircleEventName,
    P extends CareCircleAnalyticsEventMap[E] = CareCircleAnalyticsEventMap[E],
  >(
    event: E,
    ...args: EventRequiresProperties<E> extends true
      ? [properties: ExactProperties<P, CareCircleAnalyticsEventMap[E]>]
      : [properties?: ExactProperties<P, CareCircleAnalyticsEventMap[E]>]
  ): Promise<void>;
  sendTestEvent(): Promise<void>;
}

export function validateAnalyticsEvent(
  event: string,
  rawProperties?: Record<string, unknown>,
): Record<string, string | number> {
  if (!Object.prototype.hasOwnProperty.call(EVENT_PROPERTY_RULES, event)) {
    throw new AnalyticsValidationError(`Unlisted analytics event "${event}"`);
  }

  const schema = EVENT_PROPERTY_RULES[event as CareCircleEventName];
  const props = rawProperties ?? {};
  if (typeof props !== 'object' || Array.isArray(props)) {
    throw new AnalyticsValidationError(`Properties for "${event}" must be a plain object`);
  }

  const sanitized: Record<string, string | number> = {};

  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (!Object.prototype.hasOwnProperty.call(schema, key)) {
      throw new AnalyticsValidationError(`Unlisted analytics property "${key}" on "${event}"`);
    }
    const rule = schema[key];
    if (!rule) {
      throw new AnalyticsValidationError(`Unlisted analytics property "${key}" on "${event}"`);
    }
    if (rule.kind === 'enum') {
      if (typeof value !== 'string' || !rule.values.includes(value)) {
        throw new AnalyticsValidationError(
          `Invalid enum value for "${event}.${key}"; expected one of [${rule.values.join(', ')}]`,
        );
      }
      sanitized[key] = value;
    } else {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new AnalyticsValidationError(
          `Invalid count value for "${event}.${key}"; expected a non-negative integer`,
        );
      }
      sanitized[key] = value;
    }
  }

  for (const [key, rule] of Object.entries(schema)) {
    if (rule.required && !Object.prototype.hasOwnProperty.call(sanitized, key)) {
      throw new AnalyticsValidationError(`Missing required analytics property "${event}.${key}"`);
    }
  }

  return sanitized;
}

function resolveDefaultIsDev(): boolean {
  const globalDev = (globalThis as { __DEV__?: unknown }).__DEV__;
  if (typeof globalDev === 'boolean') {
    return globalDev;
  }
  return true;
}

export function createAnalyticsClient(
  adapter: PostHogAdapter,
  options?: AnalyticsClientOptions,
): AnalyticsClient {
  const reportedValidationErrors = new Set<string>();

  const validateAndCapture = async (
    event: string,
    rawProperties?: Record<string, unknown>,
  ): Promise<void> => {
    const isDev = options?.isDev ?? resolveDefaultIsDev();
    let validated: Record<string, string | number>;
    try {
      validated = validateAnalyticsEvent(event, rawProperties);
    } catch (err) {
      if (isDev) {
        throw err;
      }
      if (err instanceof AnalyticsValidationError && options?.onValidationError) {
        const dedupeKey = `${event}:${err.message}`;
        if (!reportedValidationErrors.has(dedupeKey)) {
          reportedValidationErrors.add(dedupeKey);
          try {
            options.onValidationError(err);
          } catch {
            // Never allow error reporting to break user flows in production.
          }
        }
      }
      return;
    }
    await adapter.capture(event, validated);
  };

  return {
    async track(event: CareCircleEventName, ...args: unknown[]): Promise<void> {
      const rawProperties = args[0] as Record<string, unknown> | undefined;
      await validateAndCapture(event, rawProperties);
    },
    async sendTestEvent(): Promise<void> {
      await validateAndCapture('cc_circle_created', { memberCount: 1 });
    },
  };
}

export type CrashFeatureTag =
  | 'auth'
  | 'circle'
  | 'medications'
  | 'doses'
  | 'appointments'
  | 'tasks'
  | 'visit_notes'
  | 'care_log'
  | 'paywall'
  | 'notifications'
  | 'ai_gateway';

export interface AllowedCrashTags {
  feature?: CrashFeatureTag;
  errorCode?: string;
  httpStatus?: number;
}

export interface SentryScopeContext {
  tags?: Record<string, string>;
  extra?: Record<string, string | number>;
}

export interface SentryAdapter {
  captureException(error: Error, context?: SentryScopeContext): string | void;
}

export interface CrashReporter {
  captureError<T extends AllowedCrashTags = AllowedCrashTags>(
    error: unknown,
    tags?: ExactProperties<T, AllowedCrashTags>,
  ): string | void;
  sendTestCrash(): string | void;
}

const ALLOWED_CRASH_FEATURES: ReadonlySet<string> = new Set<CrashFeatureTag>([
  'auth',
  'circle',
  'medications',
  'doses',
  'appointments',
  'tasks',
  'visit_notes',
  'care_log',
  'paywall',
  'notifications',
  'ai_gateway',
]);

const SAFE_ERROR_CODE_REGEX = /^[A-Z0-9_]{2,48}$/;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const EXPO_TOKEN_PATTERN = /(?:ExponentPushToken|ExpoPushToken)\[[^\]]+\]/g;
// Sign-in links and auth errors carry one-time codes and tokens in the URL
// (`carecircle://auth/callback?code=...`, `/verify?token_hash=...`, `#access_token=...`).
const SECRET_PARAM_PATTERN =
  /\b(code|token|token_hash|access_token|refresh_token|provider_token|apikey|api_key|key)=[^&#\s"']+/gi;
// Supabase API keys in the new format.
const SUPABASE_KEY_PATTERN = /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+/g;

export function scrubSensitiveText(input: string): string {
  return input
    .replace(EMAIL_PATTERN, '[REDACTED_EMAIL]')
    .replace(JWT_PATTERN, '[REDACTED_TOKEN]')
    .replace(BEARER_PATTERN, 'Bearer [REDACTED_TOKEN]')
    .replace(EXPO_TOKEN_PATTERN, '[REDACTED_PUSH_TOKEN]')
    .replace(SECRET_PARAM_PATTERN, '$1=[REDACTED]')
    .replace(SUPABASE_KEY_PATTERN, '[REDACTED_KEY]');
}

function validateCrashTags(rawTags?: Record<string, unknown>): SentryScopeContext | undefined {
  if (!rawTags) return undefined;
  const tags: Record<string, string> = {};
  const extra: Record<string, string | number> = {};

  for (const [key, value] of Object.entries(rawTags)) {
    if (value === undefined) continue;
    if (key === 'feature') {
      if (typeof value !== 'string' || !ALLOWED_CRASH_FEATURES.has(value)) {
        throw new AnalyticsValidationError(`Invalid crash feature tag "${String(value)}"`);
      }
      tags.feature = value;
    } else if (key === 'errorCode') {
      if (typeof value !== 'string' || !SAFE_ERROR_CODE_REGEX.test(value)) {
        throw new AnalyticsValidationError(
          `Crash errorCode must be an uppercase code token (received "${String(value)}")`,
        );
      }
      tags.error_code = value;
    } else if (key === 'httpStatus') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 599) {
        throw new AnalyticsValidationError(
          `Crash httpStatus must be an HTTP status integer 100..599`,
        );
      }
      extra.http_status = value;
    } else {
      throw new AnalyticsValidationError(`Unlisted crash tag "${key}"`);
    }
  }

  return {
    ...(Object.keys(tags).length > 0 ? { tags } : {}),
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };
}

export function createCrashReporter(sentry: SentryAdapter): CrashReporter {
  return {
    captureError<T extends AllowedCrashTags = AllowedCrashTags>(
      error: unknown,
      tags?: ExactProperties<T, AllowedCrashTags>,
    ): string | void {
      const context = validateCrashTags(tags as Record<string, unknown> | undefined);
      const rawMessage =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown application error';
      const sanitizedError = new Error(scrubSensitiveText(rawMessage));
      if (error instanceof Error && error.name) {
        sanitizedError.name = error.name;
      }
      if (error instanceof Error && typeof error.stack === 'string') {
        sanitizedError.stack = scrubSensitiveText(error.stack);
      }
      return sentry.captureException(sanitizedError, context);
    },
    sendTestCrash(): string | void {
      const testError = new Error('CareCircle Sentry verification test crash');
      return sentry.captureException(testError, {
        tags: { feature: 'ai_gateway', error_code: 'SENTRY_SMOKE_TEST' },
      });
    },
  };
}
