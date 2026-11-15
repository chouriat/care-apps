// Checked 2026-11-15 against Sentry Expo guide:
// https://docs.sentry.io/platforms/react-native/guides/expo/
// Uploading source maps requires SENTRY_AUTH_TOKEN as a secret EAS environment variable.
// When SENTRY_AUTH_TOKEN is missing (local or CI emulator builds), set disableAutoUpload: true
// so the native build succeeds and skips the upload step instead of failing.
module.exports = ({ config }) => {
  const hasSentryAuthToken = Boolean(process.env.SENTRY_AUTH_TOKEN?.trim());
  const plugins = (config.plugins ?? []).map((plugin) => {
    const name = Array.isArray(plugin) ? plugin[0] : plugin;
    if (name === '@sentry/react-native/expo') {
      const existing = Array.isArray(plugin) && plugin[1] ? plugin[1] : {};
      return [
        '@sentry/react-native/expo',
        {
          ...existing,
          disableAutoUpload: !hasSentryAuthToken,
        },
      ];
    }
    return plugin;
  });
  return {
    ...config,
    plugins,
  };
};
