import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { acceptInviteViaRpc, type AcceptInviteErrorCode } from '../../src/features/circle';
import {
  createCircleViaRpc,
  type CreateCircleErrorCode,
  type CreateCircleFormValues,
} from '../../src/features/onboarding/api';
import { OnboardingStartScreen } from '../../src/features/onboarding/components';
import { PaywallSheet } from '../../src/features/paywall/components';

export default function OnboardingStartRoute() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [isOffline, setIsOffline] = useState(false);
  const [errorCode, setErrorCode] = useState<CreateCircleErrorCode | AcceptInviteErrorCode | null>(
    null,
  );
  const [paywallVisible, setPaywallVisible] = useState(false);

  const handleCreateCircle = useCallback(
    async (values: CreateCircleFormValues): Promise<boolean> => {
      setIsLoading(true);
      setIsOffline(false);
      setErrorCode(null);
      try {
        const result = await createCircleViaRpc(values);
        // CIRCLE_LIMIT_REACHED means this account already owns a circle (for example the
        // first tap succeeded but the answer was lost): open it instead of leaving a dead end.
        if (result.ok || result.errorCode === 'CIRCLE_LIMIT_REACHED') {
          router.replace('/(tabs)/today' as never);
          return true;
        }
        setIsOffline(result.isOffline);
        setErrorCode(result.errorCode);
        if (result.errorCode === 'CIRCLE_LIMIT') {
          setPaywallVisible(true);
        }
        return false;
      } catch {
        setErrorCode('CREATE_CIRCLE_FAILED');
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    [router],
  );

  const handleJoinCircle = useCallback(
    async (tokenOrUrl: string): Promise<boolean> => {
      setIsLoading(true);
      setIsOffline(false);
      setErrorCode(null);
      try {
        const result = await acceptInviteViaRpc({ tokenOrUrl });
        if (result.ok) {
          router.replace('/(tabs)/today' as never);
          return true;
        }
        setIsOffline(result.isOffline);
        setErrorCode(result.errorCode);
        if (result.errorCode === 'CIRCLE_LIMIT') {
          setPaywallVisible(true);
        }
        return false;
      } catch {
        setErrorCode('ACCEPT_INVITE_FAILED');
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    [router],
  );

  const handleRetry = useCallback(() => {
    setIsOffline(false);
    setErrorCode(null);
  }, []);

  return (
    <View style={{ flex: 1 }}>
      <OnboardingStartScreen
        isLoading={isLoading}
        isOffline={isOffline}
        hasError={errorCode !== null && !isOffline}
        errorCode={errorCode}
        onCreateCircle={handleCreateCircle}
        onJoinCircle={handleJoinCircle}
        onRetry={handleRetry}
      />
      <PaywallSheet
        visible={paywallVisible}
        trigger="circles"
        onClose={() => setPaywallVisible(false)}
      />
    </View>
  );
}
