import * as Core from '@carecircle/core';
import * as UI from '@carecircle/ui';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import Purchases, { type PurchasesOfferings, type PurchasesPackage } from 'react-native-purchases';
import TodayScreen from '../app/(tabs)/today';
import en from '../i18n/en.json';
import {
  createCircleFormSchema,
  createCircleViaRpc,
  resolveDefaultTimezone,
} from './features/onboarding/api';
import { OnboardingStartScreen } from './features/onboarding/components';
import {
  PAYWALL_LEGAL_URLS,
  createRevenueCatSdkAdapter,
  getFamilyOffer,
  openPaywallLegalLink,
  selectFamilyPackage,
} from './features/paywall/api';
import { PaywallSheet } from './features/paywall/components';

const mockGetOfferings = jest.fn();
const mockPurchasePackage = jest.fn();

jest.mock('react-native-purchases', () => ({
  __esModule: true,
  default: {
    getOfferings: (...args: unknown[]) => mockGetOfferings(...args),
    purchasePackage: (...args: unknown[]) => mockPurchasePackage(...args),
    configure: jest.fn(),
    logIn: jest.fn(),
    logOut: jest.fn(),
    restorePurchases: jest.fn(),
  },
}));

describe('CC-1a Onboarding and create circle (apps/carecircle)', () => {
  it('defaults timezone to the device IANA timezone and switches between Create and Join choices', async () => {
    const resolvedTz = resolveDefaultTimezone(() => 'Europe/Paris');
    expect(resolvedTz).toBe('Europe/Paris');
    expect(resolveDefaultTimezone(() => 'Not/A_Zone')).toBe('UTC');

    await render(
      <UI.ThemeProvider>
        <OnboardingStartScreen defaultTimezone="Europe/Paris" />
      </UI.ThemeProvider>,
    );

    expect(screen.getByTestId('onboarding-start-screen')).toBeTruthy();
    expect(screen.getByText(en.common.notMedicalAdvice)).toBeTruthy();

    const tzInput = screen.getByTestId('onboarding-timezone-input');
    expect(tzInput.props.value).toBe('Europe/Paris');

    for (const inputId of [
      'onboarding-circle-name-input',
      'onboarding-recipient-name-input',
      'onboarding-timezone-input',
    ]) {
      const input = screen.getByTestId(inputId);
      expect(input.props.accessibilityLabel).toEqual(expect.stringMatching(/\S/));
      const flatStyle = StyleSheet.flatten(input.props.style);
      expect(flatStyle.minHeight).toBeGreaterThanOrEqual(UI.MIN_TOUCH_TARGET_PT);
    }

    const joinChoiceButton = within(screen.getByTestId('onboarding-choice-join')).getByRole(
      'button',
    );
    await fireEvent.press(joinChoiceButton);
    expect(screen.getByTestId('onboarding-join-panel')).toBeTruthy();

    const createChoiceButton = within(screen.getByTestId('onboarding-choice-create')).getByRole(
      'button',
    );
    await fireEvent.press(createChoiceButton);
    expect(screen.getByTestId('onboarding-create-form')).toBeTruthy();
  });

  it('validates form inputs with C1 Zod schema and submits trimmed values', async () => {
    const onCreateCircle = jest.fn();

    await render(
      <UI.ThemeProvider>
        <OnboardingStartScreen defaultTimezone="Europe/Paris" onCreateCircle={onCreateCircle} />
      </UI.ThemeProvider>,
    );

    const submitBtn = within(screen.getByTestId('onboarding-submit-button')).getByRole('button');

    // Submitting with empty fields shows validation error and does not call onCreateCircle.
    await fireEvent.press(submitBtn);
    expect(screen.getByTestId('onboarding-validation-error')).toBeTruthy();
    expect(onCreateCircle).not.toHaveBeenCalled();

    await fireEvent.changeText(
      screen.getByTestId('onboarding-circle-name-input'),
      '  Smith Family  ',
    );
    await fireEvent.changeText(
      screen.getByTestId('onboarding-recipient-name-input'),
      '  Evelyn Smith  ',
    );
    await fireEvent.changeText(screen.getByTestId('onboarding-timezone-input'), 'Invalid/Timezone');

    await fireEvent.press(submitBtn);
    expect(screen.getByTestId('onboarding-validation-error')).toBeTruthy();
    expect(onCreateCircle).not.toHaveBeenCalled();

    await fireEvent.changeText(screen.getByTestId('onboarding-timezone-input'), 'Europe/Paris');
    await fireEvent.press(submitBtn);

    expect(screen.queryByTestId('onboarding-validation-error')).toBeNull();
    expect(onCreateCircle).toHaveBeenCalledTimes(1);
    expect(onCreateCircle).toHaveBeenCalledWith({
      name: 'Smith Family',
      careRecipientName: 'Evelyn Smith',
      timezone: 'Europe/Paris',
    });

    expect(
      createCircleFormSchema.safeParse({
        name: 'Smith Family',
        careRecipientName: 'Evelyn Smith',
        timezone: 'Europe/Paris',
      }).success,
    ).toBe(true);
  });

  it('renders loading, error, limit-reached, and offline states on OnboardingStartScreen', async () => {
    const onRetry = jest.fn();

    const { rerender } = await render(
      <UI.ThemeProvider>
        <OnboardingStartScreen isLoading />
      </UI.ThemeProvider>,
    );
    expect(screen.getByTestId('onboarding-loading')).toBeTruthy();

    await rerender(
      <UI.ThemeProvider>
        <OnboardingStartScreen hasError errorCode="CIRCLE_LIMIT_REACHED" onRetry={onRetry} />
      </UI.ThemeProvider>,
    );
    expect(screen.getByTestId('onboarding-error')).toBeTruthy();
    expect(screen.getByText(en.onboarding.limitReachedMessage)).toBeTruthy();
    await fireEvent.press(within(screen.getByTestId('onboarding-error')).getByRole('button'));
    expect(onRetry).toHaveBeenCalledTimes(1);

    onRetry.mockClear();
    await rerender(
      <UI.ThemeProvider>
        <OnboardingStartScreen isOffline onRetry={onRetry} />
      </UI.ThemeProvider>,
    );
    expect(screen.getByTestId('onboarding-offline')).toBeTruthy();
    await fireEvent.press(within(screen.getByTestId('onboarding-offline')).getByRole('button'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('calls rpc create_circle and fires cc_circle_created once with zero circle or person names', async () => {
    const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const trackedEvents: Array<{ name: string; props: Record<string, unknown> }> = [];

    const mockCircleRow = {
      id: 'c1c00001-0000-4000-8000-000000000001',
      name: 'Smith Family',
      care_recipient_name: 'Evelyn Smith',
      care_recipient_dob: null,
      timezone: 'Europe/Paris',
      created_by: 'c1000001-1111-4111-8111-111111111111',
      created_at: '2026-11-15T12:00:00.000Z',
    };

    const result = await createCircleViaRpc(
      {
        name: '  Smith Family  ',
        careRecipientName: '  Evelyn Smith  ',
        timezone: 'Europe/Paris',
      },
      {
        getClient: () =>
          ({
            rpc: async (fn: string, args: Record<string, unknown>) => {
              rpcCalls.push({ fn, args });
              return { data: mockCircleRow, error: null };
            },
          }) as never,
        trackCircleCreated: () => {
          const props = Core.validateAnalyticsEvent('cc_circle_created', {});
          trackedEvents.push({ name: 'cc_circle_created', props });
        },
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.circle.id).toBe(mockCircleRow.id);
      expect(result.circle.name).toBe('Smith Family');
      expect(result.circle.careRecipientName).toBe('Evelyn Smith');
      expect(result.circle.timezone).toBe('Europe/Paris');
    }

    expect(rpcCalls).toEqual([
      {
        fn: 'create_circle',
        args: {
          name: 'Smith Family',
          careRecipientName: 'Evelyn Smith',
          timezone: 'Europe/Paris',
        },
      },
    ]);

    expect(trackedEvents).toHaveLength(1);
    expect(trackedEvents[0]).toEqual({ name: 'cc_circle_created', props: {} });
    const serialized = JSON.stringify(trackedEvents);
    expect(serialized).not.toContain('Smith Family');
    expect(serialized).not.toContain('Evelyn');

    // Failed RPC must NOT fire cc_circle_created.
    const failedTracked: string[] = [];
    const limitResult = await createCircleViaRpc(
      {
        name: 'Second Circle',
        careRecipientName: 'Arthur',
        timezone: 'Europe/Paris',
      },
      {
        getClient: () =>
          ({
            rpc: async () => ({
              data: null,
              error: { message: 'CIRCLE_LIMIT_REACHED', code: 'P0001' },
            }),
          }) as never,
        trackCircleCreated: () => {
          failedTracked.push('cc_circle_created');
        },
      },
    );

    expect(limitResult).toEqual({
      ok: false,
      errorCode: 'CIRCLE_LIMIT_REACHED',
      isOffline: false,
    });
    expect(failedTracked).toHaveLength(0);
  });

  it('renders the empty Today screen at /(tabs)/today and exports /(onboarding)/start route', async () => {
    const onboardingRoute = jest.requireActual<{ default?: unknown }>('../app/(onboarding)/start');
    expect(typeof onboardingRoute.default).toBe('function');

    await render(
      <UI.ThemeProvider>
        <TodayScreen />
      </UI.ThemeProvider>,
    );

    expect(screen.getByTestId('today-screen')).toBeTruthy();
    expect(screen.getByTestId('today-empty-state')).toBeTruthy();
    expect(screen.getByText(en.today.emptyTitle)).toBeTruthy();
  });
});

describe('F-5 follow-up: getFamilyOffer, monthly package selection, intro trial CTA, and legal links', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    PAYWALL_LEGAL_URLS.terms = null;
    PAYWALL_LEGAL_URLS.privacy = null;
  });

  it('selects the monthly package ($rc_monthly / offering.monthly) in both getFamilyOffer and purchaseFamilyPackage', async () => {
    const annualPkg = {
      identifier: '$rc_annual',
      packageType: 'ANNUAL',
      product: {
        identifier: 'carecircle_family_annual',
        priceString: '$49.99',
        subscriptionPeriod: 'P1Y',
        introPrice: null,
      },
    } as unknown as PurchasesPackage;

    const monthlyPkg = {
      identifier: '$rc_monthly',
      packageType: 'MONTHLY',
      product: {
        identifier: 'carecircle_family_monthly',
        priceString: '$4.99',
        subscriptionPeriod: 'P1M',
        introPrice: {
          price: 0,
          priceString: '$0.00',
          cycles: 1,
          period: 'P7D',
          periodUnit: 'DAY',
          periodNumberOfUnits: 7,
        },
      },
    } as unknown as PurchasesPackage;

    const offerings = {
      all: {},
      current: {
        identifier: 'default',
        serverDescription: 'Default offering',
        metadata: {},
        // Annual is at index 0; selector must still pick the monthly package.
        availablePackages: [annualPkg, monthlyPkg],
        monthly: monthlyPkg,
        annual: annualPkg,
        lifetime: null,
        sixMonth: null,
        threeMonth: null,
        twoMonth: null,
        weekly: null,
        webCheckoutUrl: null,
      },
    } as unknown as PurchasesOfferings;

    mockGetOfferings.mockResolvedValue(offerings);
    mockPurchasePackage.mockResolvedValue({
      customerInfo: {
        entitlements: {
          active: {
            carecircle_family: {
              isActive: true,
              periodType: 'TRIAL',
              expirationDate: '2026-11-22T00:00:00.000Z',
            },
          },
        },
      },
    });

    expect(selectFamilyPackage(offerings)).toBe(monthlyPkg);

    const offer = await getFamilyOffer();
    expect(Purchases.getOfferings).toHaveBeenCalledTimes(1);
    expect(offer).toEqual({
      priceText: '$4.99 / month',
      hasIntroOffer: true,
    });

    const adapter = createRevenueCatSdkAdapter();
    await adapter.purchaseFamilyPackage();
    expect(mockPurchasePackage).toHaveBeenCalledWith(monthlyPkg);
  });

  it('shows "Start free trial" on PaywallSheet only when hasIntroOffer is true', async () => {
    const { rerender } = await render(
      <UI.ThemeProvider>
        <PaywallSheet visible onClose={jest.fn()} priceText="$4.99 / month" hasIntroOffer={false} />
      </UI.ThemeProvider>,
    );

    expect(screen.getByText(en.paywall.subscribeCta)).toBeTruthy();
    expect(screen.queryByText(en.paywall.startFreeTrialCta)).toBeNull();

    await rerender(
      <UI.ThemeProvider>
        <PaywallSheet visible onClose={jest.fn()} priceText="$4.99 / month" hasIntroOffer />
      </UI.ThemeProvider>,
    );

    expect(screen.getByText(en.paywall.startFreeTrialCta)).toBeTruthy();
    expect(screen.queryByText(en.paywall.subscribeCta)).toBeNull();
  });

  it('wires Terms of Use and Privacy Policy links through openPaywallLegalLink', async () => {
    const openedUrls: string[] = [];
    expect(
      await openPaywallLegalLink('terms', async (url) => {
        openedUrls.push(url);
      }),
    ).toBe(false);
    expect(openedUrls).toHaveLength(0);

    PAYWALL_LEGAL_URLS.terms = 'https://carecircle.example/terms';
    PAYWALL_LEGAL_URLS.privacy = 'https://carecircle.example/privacy';

    expect(
      await openPaywallLegalLink('terms', async (url) => {
        openedUrls.push(url);
      }),
    ).toBe(true);
    expect(
      await openPaywallLegalLink('privacy', async (url) => {
        openedUrls.push(url);
      }),
    ).toBe(true);
    expect(openedUrls).toEqual([
      'https://carecircle.example/terms',
      'https://carecircle.example/privacy',
    ]);
  });
});
