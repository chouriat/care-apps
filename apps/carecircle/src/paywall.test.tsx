import * as UI from '@carecircle/ui';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import type { ComponentType } from 'react';
import { StyleSheet } from 'react-native';

interface PaywallSheetProps {
  visible: boolean;
  onClose: () => void;
  onPurchase?: () => void | Promise<boolean | void>;
  onRestorePurchases?: () => void | Promise<boolean | void>;
  onRetry?: () => void;
  isLoading?: boolean;
  isOffline?: boolean;
  hasError?: boolean;
  isActive?: boolean;
  // Store price and period from RevenueCat's offering, already formatted, e.g. "$4.99 / month".
  priceText?: string;
  onOpenTerms?: () => void;
  onOpenPrivacy?: () => void;
}

interface PaywallFeatureContract {
  PaywallSheet: ComponentType<PaywallSheetProps>;
  useEntitlement: (entitlementId: 'carecircle_family') => {
    active: boolean;
    status: 'loading' | 'ready' | 'error';
    expiresAt: string | null;
    purchase: () => Promise<boolean>;
    restorePurchases: () => Promise<boolean>;
    refresh: () => Promise<boolean>;
  };
}

function requirePaywallFeature(): PaywallFeatureContract {
  // Loaded at runtime so this tests-only PR typechecks before features/paywall exists.
  const components = jest.requireActual<Partial<PaywallFeatureContract>>(
    './features/paywall/components',
  );
  const hooks = jest.requireActual<Partial<PaywallFeatureContract>>('./features/paywall/hooks');
  if (!components.PaywallSheet || !hooks.useEntitlement) {
    throw new Error(
      'F-5 PaywallSheet and useEntitlement("carecircle_family") are not exported from features/paywall yet.',
    );
  }
  return {
    PaywallSheet: components.PaywallSheet,
    useEntitlement: hooks.useEntitlement,
  };
}

describe('F-5 PaywallSheet and useEntitlement("carecircle_family") (apps/carecircle)', () => {
  it('renders PaywallSheet with >= 44 pt targets and triggers purchase and restore purchases actions', async () => {
    const { PaywallSheet, useEntitlement } = requirePaywallFeature();
    expect(typeof useEntitlement).toBe('function');

    const onPurchase = jest.fn();
    const onRestorePurchases = jest.fn();
    const onClose = jest.fn();

    await render(
      <UI.ThemeProvider>
        <PaywallSheet
          visible
          onClose={onClose}
          onPurchase={onPurchase}
          onRestorePurchases={onRestorePurchases}
        />
      </UI.ThemeProvider>,
    );

    expect(screen.getByTestId('paywall-sheet')).toBeTruthy();

    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    for (const button of buttons) {
      expect(button.props.accessibilityLabel).toEqual(expect.stringMatching(/\S/));
      const flatStyle = StyleSheet.flatten(button.props.style);
      expect(flatStyle.minHeight).toBeGreaterThanOrEqual(UI.MIN_TOUCH_TARGET_PT);
      expect(flatStyle.minWidth).toBeGreaterThanOrEqual(UI.MIN_TOUCH_TARGET_PT);
    }

    const purchaseButton = screen.getByRole('button', { name: /trial|subscribe|upgrade|family/i });
    const restoreButton = screen.getByRole('button', { name: /restore/i });

    await fireEvent.press(purchaseButton);
    expect(onPurchase).toHaveBeenCalledTimes(1);

    await fireEvent.press(restoreButton);
    expect(onRestorePurchases).toHaveBeenCalledTimes(1);
  });

  it('renders loading, error, offline, and active states on PaywallSheet', async () => {
    const { PaywallSheet } = requirePaywallFeature();
    const onRetry = jest.fn();
    const onClose = jest.fn();

    const { rerender } = await render(
      <UI.ThemeProvider>
        <PaywallSheet visible isLoading onClose={onClose} />
      </UI.ThemeProvider>,
    );
    expect(screen.getByTestId('paywall-loading')).toBeTruthy();

    await rerender(
      <UI.ThemeProvider>
        <PaywallSheet visible hasError onRetry={onRetry} onClose={onClose} />
      </UI.ThemeProvider>,
    );
    const errorRetry = within(screen.getByTestId('paywall-error')).getByRole('button');
    await fireEvent.press(errorRetry);
    expect(onRetry).toHaveBeenCalledTimes(1);

    onRetry.mockClear();
    await rerender(
      <UI.ThemeProvider>
        <PaywallSheet visible isOffline onRetry={onRetry} onClose={onClose} />
      </UI.ThemeProvider>,
    );
    const offlineRetry = within(screen.getByTestId('paywall-offline')).getByRole('button');
    await fireEvent.press(offlineRetry);
    expect(onRetry).toHaveBeenCalledTimes(1);

    await rerender(
      <UI.ThemeProvider>
        <PaywallSheet visible isActive onClose={onClose} />
      </UI.ThemeProvider>,
    );
    expect(screen.getByTestId('paywall-active')).toBeTruthy();
  });

  // App Store Review Guideline 3.1.2 (subscriptions): the paywall shows the price and period and
  // links to the Terms of Use and the Privacy Policy, next to the restore button.
  it('shows the price and links to Terms of Use and Privacy Policy', async () => {
    const { PaywallSheet } = requirePaywallFeature();
    const onOpenTerms = jest.fn();
    const onOpenPrivacy = jest.fn();
    await render(
      <UI.ThemeProvider>
        <PaywallSheet
          visible
          onClose={jest.fn()}
          onPurchase={jest.fn()}
          onRestorePurchases={jest.fn()}
          priceText="$4.99 / month"
          onOpenTerms={onOpenTerms}
          onOpenPrivacy={onOpenPrivacy}
        />
      </UI.ThemeProvider>,
    );
    expect(screen.getByText(/\$4\.99 \/ month/)).toBeTruthy();
    for (const link of screen.getAllByRole('link')) {
      const flatStyle = StyleSheet.flatten(link.props.style);
      expect(flatStyle.minHeight).toBeGreaterThanOrEqual(UI.MIN_TOUCH_TARGET_PT);
      expect(flatStyle.minWidth).toBeGreaterThanOrEqual(UI.MIN_TOUCH_TARGET_PT);
    }
    await fireEvent.press(screen.getByRole('link', { name: /terms/i }));
    expect(onOpenTerms).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByRole('link', { name: /privacy/i }));
    expect(onOpenPrivacy).toHaveBeenCalledTimes(1);
  });

  it('cannot start a second purchase or restore while one is running', async () => {
    const { PaywallSheet } = requirePaywallFeature();
    const onPurchase = jest.fn();
    const onRestorePurchases = jest.fn();
    await render(
      <UI.ThemeProvider>
        <PaywallSheet
          visible
          isLoading
          onClose={jest.fn()}
          onPurchase={onPurchase}
          onRestorePurchases={onRestorePurchases}
        />
      </UI.ThemeProvider>,
    );
    for (const name of [/trial|subscribe|upgrade|family/i, /restore/i]) {
      const button = screen.queryByRole('button', { name });
      if (button) {
        await fireEvent.press(button);
      }
    }
    expect(onPurchase).not.toHaveBeenCalled();
    expect(onRestorePurchases).not.toHaveBeenCalled();
  });

  it('does not offer to buy again when the Family plan is already active', async () => {
    const { PaywallSheet } = requirePaywallFeature();
    const onPurchase = jest.fn();
    await render(
      <UI.ThemeProvider>
        <PaywallSheet visible isActive onClose={jest.fn()} onPurchase={onPurchase} />
      </UI.ThemeProvider>,
    );
    expect(screen.getByTestId('paywall-active')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /trial|subscribe|upgrade/i })).toBeNull();
  });
});
