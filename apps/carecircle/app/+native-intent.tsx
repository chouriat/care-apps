// Expo Router hands every link that opens the app to this function before it picks a screen.
// https://docs.expo.dev/router/advanced/native-intent/ (checked 2026-11-15)
//
// The sign-in link (carecircle://auth/callback?code=...) has no screen of its own:
// useAuthController() reads it from Linking and exchanges the code once. Without this, the
// router tried to open a route called "auth/callback" and showed "Unmatched Route" (found by
// the Maestro run on the Android emulator). When the link starts the app, go to "/" and let
// AuthGate pick sign-in or home. When the app is already open, stay where the user is.
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
  try {
    if (path.includes('auth/callback')) {
      return initial ? '/' : null;
    }
    return path;
  } catch {
    return initial ? '/' : null;
  }
}
