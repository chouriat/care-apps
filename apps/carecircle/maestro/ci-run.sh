#!/usr/bin/env bash
# CI only: install the release APK on the booted emulator and run the sign-in flow.
# On failure, print what the app logged and what was on screen, because the screenshot
# artifact is not always easy to open.
set -u
APK=apps/carecircle/android/app/build/outputs/apk/release/app-release.apk
adb install -r "$APK" || exit 1
adb logcat -c
if maestro test apps/carecircle/maestro/sign-in-magic-link.yaml; then
  exit 0
fi
echo "::group::App log (ReactNativeJS, crashes)"
adb logcat -d -s ReactNativeJS:V ReactNative:V AndroidRuntime:E | tail -n 200
echo "::endgroup::"
echo "::group::Screen contents"
maestro hierarchy 2>/dev/null | grep -E '"(text|resource-id|accessibilityText)" : "[^"]+' -o | head -n 80
echo "::endgroup::"
exit 1
