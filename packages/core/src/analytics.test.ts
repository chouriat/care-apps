import {
  ALLOWED_ANALYTICS_EVENTS,
  AnalyticsValidationError,
  createAnalyticsClient,
  createCrashReporter,
  scrubSensitiveText,
  validateAnalyticsEvent,
  type AnalyticsClient,
  type CrashReporter,
  type SentryScopeContext,
} from '../analytics';

/**
 * Compile-time type tests enforced by `pnpm typecheck` (`tsc --noEmit`).
 * If any `@ts-expect-error` line below compiles without an error, `tsc` fails with TS2578.
 */
function verifyCompileTimeEventRules(client: AnalyticsClient, reporter: CrashReporter): void {
  // Valid calls compile cleanly:
  void client.track('cc_circle_created');
  void client.track('cc_circle_created', { memberCount: 2 });
  void client.track('cc_invite_sent', { role: 'helper' });
  void client.track('cc_invite_accepted', { role: 'viewer' });
  void client.track('cc_med_added', { source: 'photo', scheduleCount: 2 });
  void client.track('cc_dose_given', { status: 'given' });
  void client.track('cc_dose_missed', { missedCount: 1 });
  void client.track('cc_visit_note_saved', {
    followUpCount: 2,
    medChangeCount: 1,
    questionCount: 3,
  });
  void client.track('cc_log_exported', { daySpan: 30, entryCount: 42 });
  void client.track('cc_paywall_viewed', { trigger: 'visit_note_ai' });
  void client.track('cc_trial_started', { entitlement: 'carecircle_family' });

  // 1. Unlisted event names fail to compile:
  // @ts-expect-error unlisted event name without cc_ prefix
  void client.track('circle_created');
  // @ts-expect-error unlisted event name with cc_ prefix
  void client.track('cc_med_deleted');

  // 2. Missing required property (`source` on `cc_med_added`) fails to compile:
  // @ts-expect-error cc_med_added requires { source }
  void client.track('cc_med_added');
  // @ts-expect-error cc_med_added requires source even when optional props are passed
  void client.track('cc_med_added', { scheduleCount: 1 });

  // 3. Unlisted / sensitive property keys fail to compile on both literals and variables:
  // @ts-expect-error medicationName is forbidden on cc_med_added
  void client.track('cc_med_added', { source: 'manual', medicationName: 'Metformin 500 mg' });
  const IndirectBadProps = { memberCount: 1, email: 'parent@example.com' };
  // @ts-expect-error email is forbidden even when passed via a variable
  void client.track('cc_circle_created', IndirectBadProps);
  // @ts-expect-error free-text summary is forbidden on cc_visit_note_saved
  void client.track('cc_visit_note_saved', { followUpCount: 1, summary: 'Patient felt dizzy' });

  // 4. Free-text strings on enum properties fail to compile:
  // @ts-expect-error source only accepts 'manual' | 'photo'
  void client.track('cc_med_added', { source: 'voice_dictation' });
  // @ts-expect-error role only accepts 'owner' | 'helper' | 'viewer'
  void client.track('cc_invite_sent', { role: 'admin' });

  // 5. Wrong types on numeric count properties fail to compile:
  // @ts-expect-error daySpan must be number
  void client.track('cc_log_exported', { daySpan: '30 days' });

  // 6. Unlisted Sentry crash tag keys fail to compile:
  // @ts-expect-error email tag is forbidden on captureError
  reporter.captureError(new Error('boom'), { feature: 'auth', email: 'a@b.c' });
}

describe('F-7 Analytics & Crash Reporting (@carecircle/core/analytics)', () => {
  it('defines the exact 10 spec events prefixed with cc_ in snake_case', () => {
    expect(typeof verifyCompileTimeEventRules).toBe('function');
    expect(ALLOWED_ANALYTICS_EVENTS).toEqual([
      'cc_circle_created',
      'cc_invite_sent',
      'cc_invite_accepted',
      'cc_med_added',
      'cc_dose_given',
      'cc_dose_missed',
      'cc_visit_note_saved',
      'cc_log_exported',
      'cc_paywall_viewed',
      'cc_trial_started',
    ]);
    for (const eventName of ALLOWED_ANALYTICS_EVENTS) {
      expect(eventName).toMatch(/^cc_[a-z]+(?:_[a-z]+)*$/);
    }
  });

  it('captures valid events and sendTestEvent in PostHog', async () => {
    const captured: Array<{ event: string; properties?: Record<string, string | number> }> = [];
    const client = createAnalyticsClient({
      capture(event, properties) {
        captured.push({ event, properties });
      },
    });

    await client.track('cc_med_added', { source: 'photo', scheduleCount: 2 });
    await client.track('cc_circle_created');
    await client.sendTestEvent();

    expect(captured).toEqual([
      { event: 'cc_med_added', properties: { source: 'photo', scheduleCount: 2 } },
      { event: 'cc_circle_created', properties: {} },
      { event: 'cc_circle_created', properties: { memberCount: 1 } },
    ]);
  });

  it('rejects unlisted events, forbidden keys, missing required props, free-text enums, and bad counts at runtime', async () => {
    const captured: string[] = [];
    const client = createAnalyticsClient({
      capture(event) {
        captured.push(event);
      },
    });

    expect(() => validateAnalyticsEvent('cc_unknown_event', {})).toThrow(AnalyticsValidationError);
    expect(() => validateAnalyticsEvent('toString', {})).toThrow(AnalyticsValidationError);
    expect(() =>
      validateAnalyticsEvent('cc_med_added', {
        source: 'manual',
        medicationName: 'Lisinopril',
      }),
    ).toThrow(/Unlisted analytics property "medicationName"/);
    expect(() => validateAnalyticsEvent('cc_med_added', {})).toThrow(
      /Missing required analytics property "cc_med_added\.source"/,
    );
    expect(() => validateAnalyticsEvent('cc_med_added', { source: 'free text' })).toThrow(
      /Invalid enum value/,
    );
    expect(() => validateAnalyticsEvent('cc_visit_note_saved', { followUpCount: -1 })).toThrow(
      /Invalid count value/,
    );
    expect(() => validateAnalyticsEvent('cc_visit_note_saved', { followUpCount: 1.5 })).toThrow(
      /Invalid count value/,
    );
    expect(() =>
      validateAnalyticsEvent('cc_visit_note_saved', { followUpCount: Number.NaN }),
    ).toThrow(/Invalid count value/);
    expect(() =>
      validateAnalyticsEvent('cc_circle_created', [] as unknown as Record<string, unknown>),
    ).toThrow(/plain object/);

    await expect(
      (client.track as (e: string, p?: unknown) => Promise<void>)('cc_med_added', {
        source: 'manual',
        email: 'user@example.com',
      }),
    ).rejects.toThrow(AnalyticsValidationError);

    expect(captured).toHaveLength(0);
  });

  it('scrubs emails, JWTs, Bearer tokens, and Expo push tokens before forwarding crashes to Sentry', () => {
    const captured: Array<{ error: Error; context?: SentryScopeContext }> = [];
    const reporter = createCrashReporter({
      captureException(error, context) {
        captured.push({ error, context });
        return 'sentry-event-1';
      },
    });

    const rawError = new Error(
      'Auth failed for alice.smith@example.com with Bearer secret_token_123 and jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2ln and ExponentPushToken[abc_123]',
    );
    rawError.stack =
      'Error: alice.smith@example.com Bearer secret_token_123\n    at signIn (auth.ts:10:5)';

    const eventId = reporter.captureError(rawError, {
      feature: 'auth',
      errorCode: 'AUTH_EXCHANGE_FAILED',
      httpStatus: 401,
    });

    expect(eventId).toBe('sentry-event-1');
    expect(captured).toHaveLength(1);
    const first = captured[0];
    expect(first?.error.message).not.toContain('alice.smith@example.com');
    expect(first?.error.message).not.toContain('secret_token_123');
    expect(first?.error.message).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(first?.error.message).not.toContain('ExponentPushToken[abc_123]');
    expect(first?.error.message).toContain('[REDACTED_EMAIL]');
    expect(first?.error.message).toContain('[REDACTED_TOKEN]');
    expect(first?.error.message).toContain('[REDACTED_PUSH_TOKEN]');
    expect(first?.error.stack).not.toContain('alice.smith@example.com');
    expect(first?.error.stack).not.toContain('secret_token_123');
    expect(first?.context).toEqual({
      tags: { feature: 'auth', error_code: 'AUTH_EXCHANGE_FAILED' },
      extra: { http_status: 401 },
    });

    reporter.sendTestCrash();
    expect(captured).toHaveLength(2);
    expect(captured[1]?.error.message).toBe('CareCircle Sentry verification test crash');
    expect(captured[1]?.context).toEqual({
      tags: { feature: 'ai_gateway', error_code: 'SENTRY_SMOKE_TEST' },
    });
  });

  it('rejects unlisted or free-text crash tags in createCrashReporter', () => {
    const reporter = createCrashReporter({
      captureException() {
        return 'id';
      },
    });

    expect(() =>
      reporter.captureError(new Error('fail'), {
        feature: 'unknown_feature' as 'auth',
      }),
    ).toThrow(/Invalid crash feature tag/);

    expect(() =>
      reporter.captureError(new Error('fail'), {
        errorCode: 'Free text with patient name Jane Doe',
      }),
    ).toThrow(/Crash errorCode must be an uppercase code token/);

    expect(() =>
      reporter.captureError(new Error('fail'), {
        httpStatus: 999,
      }),
    ).toThrow(/Crash httpStatus/);

    expect(() =>
      (reporter.captureError as (e: unknown, t: Record<string, unknown>) => void)(
        new Error('fail'),
        { medicationName: 'Metformin' },
      ),
    ).toThrow(/Unlisted crash tag "medicationName"/);

    expect(scrubSensitiveText('Contact bob@care.org')).toBe('Contact [REDACTED_EMAIL]');
  });
  it('scrubs one-time codes and tokens from sign-in links, and Supabase keys', () => {
    const cases: Array<[string, string]> = [
      [
        'Auth failed for carecircle://auth/callback?code=9f8e7d6c-5b4a&state=x',
        'Auth failed for carecircle://auth/callback?code=[REDACTED]&state=x',
      ],
      [
        'GET https://x.supabase.co/auth/v1/verify?token_hash=pkce_abc123&type=magiclink',
        'GET https://x.supabase.co/auth/v1/verify?token_hash=[REDACTED]&type=magiclink',
      ],
      [
        'carecircle://auth/callback#access_token=abc&refresh_token=v1.Mr5mfs&expires_in=3600',
        'carecircle://auth/callback#access_token=[REDACTED]&refresh_token=[REDACTED]&expires_in=3600',
      ],
      ['apikey sb_secret_AbCd_123 leaked', 'apikey [REDACTED_KEY] leaked'],
      ['?apikey=sb_publishable_xyz', '?apikey=[REDACTED]'],
    ];
    for (const [input, expected] of cases) {
      expect(scrubSensitiveText(input)).toBe(expected);
    }
  });
});
