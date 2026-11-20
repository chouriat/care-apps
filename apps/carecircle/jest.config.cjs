module.exports = {
  preset: 'jest-expo',
  // Some tests load a whole feature (Supabase, Expo modules, RevenueCat) inside the test the first
  // time; with a cold transform cache and turbo running every package at once this took about
  // 12 s, over Jest's 5 s default (seen in the PR #21 review for paywall.test.tsx).
  testTimeout: 20000,
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/src/**/*.test.tsx'],
  moduleNameMapper: {
    '^@sentry/react-native$': '<rootDir>/src/__mocks__/sentry-react-native.ts',
    '^posthog-react-native$': '<rootDir>/src/__mocks__/posthog-react-native.ts',
    '^expo-sharing$': '<rootDir>/src/__mocks__/expo-sharing.ts',
  },
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|@revenuecat/.*|standard-navigation)',
  ],
};
