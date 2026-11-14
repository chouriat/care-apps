import { SignInScreen } from '../../src/features/auth/components';
import { useAuthController } from '../../src/features/auth/hooks';

export default function SignInRoute() {
  const { state, signInWithEmail, signInWithOAuth, retry } = useAuthController();
  const isOffline = state.errorCode === 'NETWORK_ERROR';
  const hasError = state.errorCode !== null && !isOffline;

  return (
    <SignInScreen
      onSendMagicLink={signInWithEmail}
      onSignInOAuth={signInWithOAuth}
      onRetry={retry}
      isLoading={state.isSubmitting}
      isOffline={isOffline}
      hasError={hasError}
      magicLinkSent={state.magicLinkSent}
    />
  );
}
