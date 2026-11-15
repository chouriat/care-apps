// Checked 2026-11-15 against Sentry Expo guide:
// https://docs.sentry.io/platforms/react-native/guides/expo/
// and the plugin source in @sentry/react-native 8.28.0 (plugin/build/withSentry.js):
// `disableAutoUpload` is a real plugin option; without `organization` / `project` in the plugin
// props, sentry-cli falls back to SENTRY_ORG / SENTRY_PROJECT and the upload fails without them.
// So the upload runs only when the token, org and project are all set (as secret / plain EAS
// environment variables). Otherwise the build still succeeds and just skips the upload.
const DEV_CHECKS_PROFILES = ['development', 'preview'];

function isSet(value) {
  return Boolean(value && String(value).trim());
}

module.exports = ({ config }) => {
  // The dev checks screen must never ship in a store build. eas.json only sets the flag for
  // `development` and `preview`, but an EAS dashboard variable could add it to any profile.
  const profile = process.env.EAS_BUILD_PROFILE;
  if (
    isSet(profile) &&
    !DEV_CHECKS_PROFILES.includes(profile) &&
    process.env.EXPO_PUBLIC_DEV_CHECKS !== undefined
  ) {
    throw new Error(
      `CareCircle: EXPO_PUBLIC_DEV_CHECKS is set for the "${profile}" EAS build profile. ` +
        'It is allowed only for development and preview. Remove it from that EAS environment.',
    );
  }

  const plugins = (config.plugins ?? []).map((plugin) => {
    const name = Array.isArray(plugin) ? plugin[0] : plugin;
    if (name !== '@sentry/react-native/expo') return plugin;
    const existing = Array.isArray(plugin) && plugin[1] ? plugin[1] : {};
    const canUpload =
      isSet(process.env.SENTRY_AUTH_TOKEN) &&
      (isSet(existing.organization) || isSet(process.env.SENTRY_ORG)) &&
      (isSet(existing.project) || isSet(process.env.SENTRY_PROJECT));
    return ['@sentry/react-native/expo', { ...existing, disableAutoUpload: !canUpload }];
  });
  return { ...config, plugins };
};
