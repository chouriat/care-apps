import * as UI from '@carecircle/ui';
import { Redirect } from 'expo-router';
import { useState } from 'react';
import { Share, Text } from 'react-native';
import en from '../i18n/en.json';
import {
  getAppPushNotificationsController,
  scheduleNeutralDoseReminder,
} from '../src/features/notifications/api';
import { getAppObservability } from '../src/features/observability/api';

const FAKE_DOSE_EVENT_ID = '00000000-0000-4000-8000-000000000001';

// Only the exact value '1' turns the screen on. eas.json sets it for `development` and
// `preview`; app.config.js fails any other EAS build that has it.
export function isDevChecksEnabled(): boolean {
  return (
    (globalThis as { __DEV__?: boolean }).__DEV__ === true ||
    process.env.EXPO_PUBLIC_DEV_CHECKS === '1'
  );
}

export function oneMinuteFromNowInPhoneTz(nowMs: number = Date.now()): {
  date: string;
  time: string;
  timeZone: string;
} {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(nowMs + 60_000));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  const rawHour = get('hour');
  const hour = rawHour === '24' ? '00' : rawHour;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${hour}:${get('minute')}`,
    timeZone,
  };
}

export default function DevChecksScreen() {
  const { colors: c, typography: t } = UI.useTheme();
  const [token, setToken] = useState<string | null>(null);
  const [tokenShown, setTokenShown] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  if (!isDevChecksEnabled()) {
    return <Redirect href="/" />;
  }

  const d = en.devChecks;
  const obs = getAppObservability();
  return (
    <UI.Screen accessibilityLabel={d.title}>
      <UI.Header title={d.title} subtitle={d.subtitle} />
      {/* Shows at once when a build is missing the Sentry or PostHog key (the PR #19 bug). */}
      <Text testID="dev-checks-sdk-state" style={[t.bodySmall, { color: c.textSecondary }]}>
        {`${d.sentryLabel}: ${obs.isSentryEnabled ? d.on : d.off} · ${d.posthogLabel}: ${
          obs.isPostHogEnabled ? d.on : d.off
        }`}
      </Text>
      <UI.Button
        label={d.testReminder}
        onPress={() => {
          scheduleNeutralDoseReminder({
            ...oneMinuteFromNowInPhoneTz(),
            doseEventId: FAKE_DOSE_EVENT_ID,
          }).then(
            () => setStatus(d.statusReminderScheduled),
            () => setStatus(d.statusReminderFailed),
          );
        }}
      />
      <UI.Button
        label={d.showPushToken}
        variant="secondary"
        onPress={() => {
          setToken(getAppPushNotificationsController().getCurrentToken());
          setTokenShown(true);
        }}
      />
      {tokenShown ? (
        <UI.Card tone="muted">
          <Text
            selectable
            testID="dev-checks-push-token"
            style={[t.body, { color: c.textPrimary }]}
          >
            {token ?? d.pushTokenUnavailable}
          </Text>
          {token ? (
            <UI.Button
              label={d.copyPushToken}
              variant="secondary"
              onPress={() => {
                void Share.share({ message: token });
              }}
            />
          ) : null}
        </UI.Card>
      ) : null}
      <UI.Button
        label={d.sendTestCrash}
        variant="danger"
        onPress={() => {
          obs.crashReporter.sendTestCrash();
          setStatus(obs.isSentryEnabled ? d.statusCrashSent : d.statusSentryOff);
        }}
      />
      <UI.Button
        label={d.sendTestEvent}
        variant="secondary"
        onPress={() => {
          obs.analytics.sendTestEvent().then(
            () => setStatus(obs.isPostHogEnabled ? d.statusEventSent : d.statusPostHogOff),
            () => setStatus(d.statusEventFailed),
          );
        }}
      />
      {status ? (
        <Text testID="dev-checks-status" style={[t.bodySmall, { color: c.textSecondary }]}>
          {status}
        </Text>
      ) : null}
    </UI.Screen>
  );
}
