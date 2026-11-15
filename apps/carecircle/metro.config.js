// Checked 2026-11-15 against Sentry Expo guide:
// https://docs.sentry.io/platforms/react-native/guides/expo/
const { getSentryExpoConfig } = require('@sentry/react-native/metro');

const config = getSentryExpoConfig(__dirname);

module.exports = config;
