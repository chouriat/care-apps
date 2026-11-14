import * as UI from '@carecircle/ui';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ComponentType, ReactNode } from 'react';
import { StyleSheet, Text } from 'react-native';
import * as LayoutModule from '../app/_layout';

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
  signInProps?: SignInScreenProps;
  children: ReactNode;
}

interface AuthLayoutContract {
  SignInScreen: ComponentType<SignInScreenProps>;
  AuthGate: ComponentType<AuthGateProps>;
}

function requireAuthLayout(): AuthLayoutContract {
  const candidate = LayoutModule as Partial<AuthLayoutContract>;
  if (!candidate.SignInScreen || !candidate.AuthGate) {
    throw new Error('F-4 SignInScreen and AuthGate are not exported from app/_layout yet.');
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
    expect(screen.getByTestId('sign-in-screen')).toBeTruthy();
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
    expect(screen.getByTestId('sign-in-screen')).toBeTruthy();
    expect(screen.queryByTestId('protected-route-content')).toBeNull();

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
    const [magicLinkButton, appleButton, googleButton] = buttons;
    if (!magicLinkButton || !appleButton || !googleButton) {
      throw new Error('Expected magic link, Apple, and Google sign-in buttons');
    }

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
    expect(screen.getByTestId('sign-in-error')).toBeTruthy();
    const errorRetryButton = screen.getAllByRole('button')[0];
    if (!errorRetryButton) throw new Error('Expected error retry button');
    await fireEvent.press(errorRetryButton);
    expect(onRetry).toHaveBeenCalledTimes(1);

    onRetry.mockClear();
    await rerender(
      <UI.ThemeProvider>
        <SignInScreen isOffline onRetry={onRetry} />
      </UI.ThemeProvider>,
    );
    expect(screen.getByTestId('sign-in-offline')).toBeTruthy();
    const offlineRetryButton = screen.getAllByRole('button')[0];
    if (!offlineRetryButton) throw new Error('Expected offline retry button');
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
