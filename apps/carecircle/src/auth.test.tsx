import * as UI from '@carecircle/ui';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import type { ComponentType, ReactNode } from 'react';
import { StyleSheet, Text } from 'react-native';

type AuthProvider = 'apple' | 'google';
type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface SignInScreenProps {
  onSendMagicLink?: (email: string) => void | Promise<boolean | void>;
  onSignInOAuth?: (provider: AuthProvider) => void | Promise<boolean | void>;
  onRetry?: () => void;
  isLoading?: boolean;
  isOffline?: boolean;
  hasError?: boolean;
  magicLinkSent?: boolean;
  initialEmail?: string;
}

interface AuthGateProps {
  status: AuthStatus;
  pathname: string;
  onRedirect?: (targetRoute: string) => void;
  children: ReactNode;
}

interface AuthLayoutContract {
  SignInScreen: ComponentType<SignInScreenProps>;
  AuthGate: ComponentType<AuthGateProps>;
}

// AGENTS.md section 4: UI pieces live in src/features/<feature>/components, not in route files.
function requireAuthLayout(): AuthLayoutContract {
  // Loaded at runtime so this tests-only PR still typechecks before the code exists.
  const candidate = jest.requireActual<Partial<AuthLayoutContract>>('./features/auth/components');
  if (!candidate.SignInScreen || !candidate.AuthGate) {
    throw new Error('F-4 SignInScreen and AuthGate are not exported from features/auth yet.');
  }
  return candidate as AuthLayoutContract;
}

describe('F-4 Auth screen and route protection (apps/carecircle)', () => {
  it('redirects signed-out users to /(auth)/sign-in from root and deep links, and allows signed-in users', async () => {
    const { AuthGate } = requireAuthLayout();
    const onRedirect = jest.fn<void, [string]>();

    const { rerender } = await render(
      <UI.ThemeProvider>
        <AuthGate status="unauthenticated" pathname="/" onRedirect={onRedirect}>
          <Text testID="protected-route-content">Protected Today Screen</Text>
        </AuthGate>
      </UI.ThemeProvider>,
    );

    expect(onRedirect).toHaveBeenCalledWith('/(auth)/sign-in');
    expect(screen.queryByTestId('protected-route-content')).toBeNull();

    // Deep link while signed out must also redirect to /(auth)/sign-in.
    onRedirect.mockClear();
    await rerender(
      <UI.ThemeProvider>
        <AuthGate status="unauthenticated" pathname="/gallery" onRedirect={onRedirect}>
          <Text testID="protected-route-content">Protected Gallery Screen</Text>
        </AuthGate>
      </UI.ThemeProvider>,
    );

    expect(onRedirect).toHaveBeenCalledWith('/(auth)/sign-in');
    expect(screen.queryByTestId('protected-route-content')).toBeNull();

    // While the stored session is still loading, show neither protected content nor a redirect.
    onRedirect.mockClear();
    await rerender(
      <UI.ThemeProvider>
        <AuthGate status="loading" pathname="/gallery" onRedirect={onRedirect}>
          <Text testID="protected-route-content">Protected Gallery Screen</Text>
        </AuthGate>
      </UI.ThemeProvider>,
    );
    expect(onRedirect).not.toHaveBeenCalled();
    expect(screen.queryByTestId('protected-route-content')).toBeNull();
    expect(screen.getByTestId('auth-loading')).toBeTruthy();

    // The sign-in route itself (usePathname() reports '/sign-in') renders without a redirect loop.
    await rerender(
      <UI.ThemeProvider>
        <AuthGate status="unauthenticated" pathname="/sign-in" onRedirect={onRedirect}>
          <Text testID="sign-in-route-content">Sign-in route</Text>
        </AuthGate>
      </UI.ThemeProvider>,
    );
    expect(onRedirect).not.toHaveBeenCalled();
    expect(screen.getByTestId('sign-in-route-content')).toBeTruthy();

    // Signed-in user at a deep link is not redirected and sees the protected route.
    onRedirect.mockClear();
    await rerender(
      <UI.ThemeProvider>
        <AuthGate status="authenticated" pathname="/gallery" onRedirect={onRedirect}>
          <Text testID="protected-route-content">Protected Gallery Screen</Text>
        </AuthGate>
      </UI.ThemeProvider>,
    );

    expect(onRedirect).not.toHaveBeenCalled();
    expect(screen.getByTestId('protected-route-content')).toBeTruthy();

    // The spec's route exists as a real Expo Router file.
    const signInRoute = jest.requireActual<{ default?: unknown }>('../app/(auth)/sign-in');
    expect(typeof signInRoute.default).toBe('function');
  });

  it('renders SignInScreen controls with >= 44 pt targets and triggers email, Apple, and Google sign-in', async () => {
    const { SignInScreen } = requireAuthLayout();
    const onSendMagicLink = jest.fn<void, [string]>();
    const onSignInOAuth = jest.fn<void, [AuthProvider]>();

    await render(
      <UI.ThemeProvider>
        <SignInScreen onSendMagicLink={onSendMagicLink} onSignInOAuth={onSignInOAuth} />
      </UI.ThemeProvider>,
    );

    expect(screen.getByTestId('sign-in-screen')).toBeTruthy();
    const emailInput = screen.getByTestId('sign-in-email-input');
    expect(emailInput.props.accessibilityLabel).toEqual(expect.stringMatching(/\S/));
    expect(StyleSheet.flatten(emailInput.props.style).minHeight).toBeGreaterThanOrEqual(
      UI.MIN_TOUCH_TARGET_PT,
    );

    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    for (const button of buttons) {
      expect(button.props.accessibilityLabel).toEqual(expect.stringMatching(/\S/));
      const flatStyle = StyleSheet.flatten(button.props.style);
      expect(flatStyle.minHeight).toBeGreaterThanOrEqual(UI.MIN_TOUCH_TARGET_PT);
      expect(flatStyle.minWidth).toBeGreaterThanOrEqual(UI.MIN_TOUCH_TARGET_PT);
    }

    await fireEvent.changeText(emailInput, 'helper.omar@example.com');
    // Found by their accessibility labels, not by position.
    const magicLinkButton = screen.getByRole('button', { name: /magic link|email/i });
    const appleButton = screen.getByRole('button', { name: /apple/i });
    const googleButton = screen.getByRole('button', { name: /google/i });

    await fireEvent.press(magicLinkButton);
    expect(onSendMagicLink).toHaveBeenCalledWith('helper.omar@example.com');

    await fireEvent.press(appleButton);
    expect(onSignInOAuth).toHaveBeenCalledWith('apple');

    await fireEvent.press(googleButton);
    expect(onSignInOAuth).toHaveBeenCalledWith('google');
  });

  it('renders loading, error, offline, and magic-link-sent states on SignInScreen', async () => {
    const { SignInScreen } = requireAuthLayout();
    const onRetry = jest.fn();

    const { rerender } = await render(
      <UI.ThemeProvider>
        <SignInScreen isLoading />
      </UI.ThemeProvider>,
    );
    expect(screen.getByTestId('sign-in-loading')).toBeTruthy();

    await rerender(
      <UI.ThemeProvider>
        <SignInScreen hasError onRetry={onRetry} />
      </UI.ThemeProvider>,
    );
    const errorRetryButton = within(screen.getByTestId('sign-in-error')).getByRole('button');
    await fireEvent.press(errorRetryButton);
    expect(onRetry).toHaveBeenCalledTimes(1);

    onRetry.mockClear();
    await rerender(
      <UI.ThemeProvider>
        <SignInScreen isOffline onRetry={onRetry} />
      </UI.ThemeProvider>,
    );
    const offlineRetryButton = within(screen.getByTestId('sign-in-offline')).getByRole('button');
    await fireEvent.press(offlineRetryButton);
    expect(onRetry).toHaveBeenCalledTimes(1);

    await rerender(
      <UI.ThemeProvider>
        <SignInScreen magicLinkSent />
      </UI.ThemeProvider>,
    );
    expect(screen.getByTestId('sign-in-magic-link-sent')).toBeTruthy();
  });
});
