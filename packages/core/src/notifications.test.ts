import {
  computeUtcTriggerForLocalTime,
  isValidIanaTimeZone,
  registerPushToken,
  scheduleLocalReminder,
  type LocalNotificationAdapter,
  type LocalNotificationRequest,
  type PushTokenRegistration,
} from './index';

describe('F-6 Notifications helper (@carecircle/core)', () => {
  it('computes the exact UTC trigger for local times across IANA timezones', () => {
    // Winter EST (UTC-5): 08:00 in America/New_York -> 13:00Z
    const nyWinter = computeUtcTriggerForLocalTime({
      date: '2026-01-15',
      time: '08:00',
      timeZone: 'America/New_York',
    });
    expect(nyWinter.triggerAtIso).toBe('2026-01-15T13:00:00.000Z');
    expect(nyWinter.adjustedLocalTime).toBe('08:00');

    // Summer CEST (UTC+2): 20:00 in Europe/Paris -> 18:00Z
    const parisSummer = computeUtcTriggerForLocalTime({
      date: '2026-07-15',
      time: '20:00',
      timeZone: 'Europe/Paris',
    });
    expect(parisSummer.triggerAtIso).toBe('2026-07-15T18:00:00.000Z');
    expect(parisSummer.adjustedLocalTime).toBe('20:00');

    // Half-hour offset IST (UTC+5:30): 09:15 in Asia/Kolkata -> 03:45Z
    const kolkata = computeUtcTriggerForLocalTime({
      date: '2026-05-10',
      time: '09:15',
      timeZone: 'Asia/Kolkata',
    });
    expect(kolkata.triggerAtIso).toBe('2026-05-10T03:45:00.000Z');

    // Date-line boundary: 00:30 in Asia/Tokyo (UTC+9) -> previous UTC day 15:30Z
    const tokyoMidnight = computeUtcTriggerForLocalTime({
      date: '2026-04-01',
      time: '00:30',
      timeZone: 'Asia/Tokyo',
    });
    expect(tokyoMidnight.triggerAtIso).toBe('2026-03-31T15:30:00.000Z');
  });

  it('handles DST spring-forward non-existent times (02:30 -> 03:00) and fall-back repeated times', () => {
    // US spring-forward: 2026-03-08 in America/New_York jumps from 01:59 EST to 03:00 EDT (07:00Z)
    const springForwardNy = computeUtcTriggerForLocalTime({
      date: '2026-03-08',
      time: '02:30',
      timeZone: 'America/New_York',
    });
    expect(springForwardNy.adjustedLocalTime).toBe('03:00');
    expect(springForwardNy.triggerAtIso).toBe('2026-03-08T07:00:00.000Z');

    // EU spring-forward: 2026-03-29 in Europe/Paris jumps from 01:59 CET to 03:00 CEST (01:00Z)
    const springForwardParis = computeUtcTriggerForLocalTime({
      date: '2026-03-29',
      time: '02:30',
      timeZone: 'Europe/Paris',
    });
    expect(springForwardParis.adjustedLocalTime).toBe('03:00');
    expect(springForwardParis.triggerAtIso).toBe('2026-03-29T01:00:00.000Z');

    // US fall-back: 2026-11-01 01:30 in America/New_York repeats (05:30Z EDT, then 06:30Z EST).
    // Fires once at the first occurrence (05:30Z).
    const fallBackNy = computeUtcTriggerForLocalTime({
      date: '2026-11-01',
      time: '01:30',
      timeZone: 'America/New_York',
    });
    expect(fallBackNy.adjustedLocalTime).toBe('01:30');
    expect(fallBackNy.triggerAtIso).toBe('2026-11-01T05:30:00.000Z');
  });

  it('rejects invalid dates, wall times, and IANA timezones', () => {
    expect(isValidIanaTimeZone('Europe/Paris')).toBe(true);
    expect(isValidIanaTimeZone(' Europe/Paris ')).toBe(false);
    expect(isValidIanaTimeZone('Not/A_Real_Zone')).toBe(false);
    expect(isValidIanaTimeZone('')).toBe(false);

    expect(() =>
      computeUtcTriggerForLocalTime({
        date: '2026/05/01',
        time: '08:00',
        timeZone: 'Europe/Paris',
      }),
    ).toThrow(/Invalid calendar date/i);

    expect(() =>
      computeUtcTriggerForLocalTime({
        date: '2026-02-30',
        time: '08:00',
        timeZone: 'Europe/Paris',
      }),
    ).toThrow(/Non-existent calendar date/i);

    expect(() =>
      computeUtcTriggerForLocalTime({
        date: '2026-05-01',
        time: '25:00',
        timeZone: 'Europe/Paris',
      }),
    ).toThrow(/local time/i);

    expect(() =>
      computeUtcTriggerForLocalTime({
        date: '2026-05-01',
        time: '08:00',
        timeZone: 'Invalid/Timezone',
      }),
    ).toThrow(/IANA timezone/i);
  });

  it('schedules a local notification at the computed UTC trigger date', async () => {
    const scheduled: LocalNotificationRequest[] = [];
    const adapter: LocalNotificationAdapter = {
      async scheduleNotificationAsync(req) {
        scheduled.push(req);
        return 'local-notif-1';
      },
      async cancelScheduledNotificationAsync() {},
    };

    const result = await scheduleLocalReminder(adapter, {
      identifier: 'dose-123',
      date: '2026-03-08',
      time: '02:30',
      timeZone: 'America/New_York',
      title: 'Metformin 500 mg',
      body: '1 tablet due now',
      data: { doseEventId: 'dose-123' },
    });

    expect(result.notificationId).toBe('local-notif-1');
    expect(result.adjustedLocalTime).toBe('03:00');
    expect(result.triggerAtIso).toBe('2026-03-08T07:00:00.000Z');
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.title).toBe('Metformin 500 mg');
    expect(scheduled[0]?.body).toBe('1 tablet due now');
    expect(scheduled[0]?.identifier).toBe('dose-123');
    expect(scheduled[0]?.data).toEqual({ doseEventId: 'dose-123' });
    expect(scheduled[0]?.triggerDate.toISOString()).toBe('2026-03-08T07:00:00.000Z');

    await expect(
      scheduleLocalReminder(adapter, {
        date: '2026-03-08',
        time: '08:00',
        timeZone: 'America/New_York',
        title: '   ',
        body: '1 tablet due now',
      }),
    ).rejects.toThrow(/title and body/i);

    await expect(
      scheduleLocalReminder(adapter, {
        date: '2026-03-08',
        time: '08:00',
        timeZone: 'America/New_York',
        title: 'Metformin 500 mg',
        body: '   ',
      }),
    ).rejects.toThrow(/title and body/i);
  });

  it('validates and registers Expo push tokens into push_tokens', async () => {
    const stored: PushTokenRegistration[] = [];
    const store = {
      registerPushToken: async (row: PushTokenRegistration) => {
        stored.push(row);
        return { error: null };
      },
    };
    const row = await registerPushToken(store, {
      token: ' ExponentPushToken[abc123_XYZ-789] ',
      platform: 'ios',
    });

    // No user id is sent: the database takes the user from the session.
    expect(row).toEqual({ token: 'ExponentPushToken[abc123_XYZ-789]', platform: 'ios' });
    expect(stored).toEqual([{ token: 'ExponentPushToken[abc123_XYZ-789]', platform: 'ios' }]);

    await expect(
      registerPushToken(store, {
        token: 'ExponentPushToken[abc123_XYZ-789]',
        platform: 'web' as 'ios',
      }),
    ).rejects.toThrow(/ios or android/i);

    await expect(
      registerPushToken(store, {
        token: 'not-an-expo-token',
        platform: 'android',
      }),
    ).rejects.toThrow(/Expo push token/i);

    const failingStore = {
      registerPushToken: async () => ({
        error: { message: 'RLS violation', code: '42501' },
      }),
    };
    await expect(
      registerPushToken(failingStore, {
        token: 'ExpoPushToken[abc123_XYZ-789]',
        platform: 'android',
      }),
    ).rejects.toThrow(/42501/);
  });
});
