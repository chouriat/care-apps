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

export function isDevChecksEnabled(): boolean {
  return (
    (globalThis as { __DEV__?: boolean }).__DEV__ === true ||
    process.env.EXPO_PUBLIC_DEV_CHECKS === '1'
  );
}

function oneMinuteFromNowInPhoneTz(nowMs: number = Date.now()): {
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
  return (
    <UI.Screen accessibilityLabel={d.title}>
      <UI.Header title={d.title} subtitle={d.subtitle} />
      <UI.Button
        label={d.testReminder}
        onPress={() => {
          void scheduleNeutralDoseReminder({
            ...oneMinuteFromNowInPhoneTz(),
            doseEventId: FAKE_DOSE_EVENT_ID,
          }).then(() => setStatus(d.statusReminderScheduled));
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
          getAppObservability().crashReporter.sendTestCrash();
          setStatus(d.statusCrashSent);
        }}
      />
      <UI.Button
        label={d.sendTestEvent}
        variant="secondary"
        onPress={() => {
          void getAppObservability()
            .analytics.sendTestEvent()
            .then(() => setStatus(d.statusEventSent));
        }}
      />
      {status ? <Text style={[t.bodySmall, { color: c.textSecondary }]}>{status}</Text> : null}
    </UI.Screen>
  );
}
