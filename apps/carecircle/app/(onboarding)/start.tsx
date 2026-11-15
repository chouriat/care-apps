import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  createCircleViaRpc,
  type CreateCircleErrorCode,
  type CreateCircleFormValues,
} from '../../src/features/onboarding/api';
import { OnboardingStartScreen } from '../../src/features/onboarding/components';

export default function OnboardingStartRoute() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [isOffline, setIsOffline] = useState(false);
  const [errorCode, setErrorCode] = useState<CreateCircleErrorCode | null>(null);

  const handleCreateCircle = useCallback(
    async (values: CreateCircleFormValues): Promise<boolean> => {
      setIsLoading(true);
      setIsOffline(false);
      setErrorCode(null);
      try {
        const result = await createCircleViaRpc(values);
        if (result.ok) {
          router.replace('/(tabs)/today' as never);
          return true;
        }
        setIsOffline(result.isOffline);
        setErrorCode(result.errorCode);
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
    <OnboardingStartScreen
      isLoading={isLoading}
      isOffline={isOffline}
      hasError={errorCode !== null && !isOffline}
      errorCode={errorCode}
      onCreateCircle={handleCreateCircle}
      onRetry={handleRetry}
    />
  );
}
