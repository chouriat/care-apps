#!/usr/bin/env bash
# CI only: install the release APK on the booted emulator and run the sign-in flow.
# On failure, print what the app logged and what was on screen, because the screenshot
# artifact is not always easy to open.
set -u
APK=apps/carecircle/android/app/build/outputs/apk/release/app-release.apk
# The CI emulator is slow, and the home screen app often shows "isn't responding" on top of
# everything. Hide those system popups (a setting meant for automated tests), let the
# emulator settle, and close any popup already open.
adb shell settings put global hide_error_dialogs 1
adb shell settings put secure anr_show_background 0
sleep 20
adb shell input keyevent KEYCODE_HOME
adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS >/dev/null 2>&1 || true
adb install -r "$APK" || exit 1
adb push evals/carecircle/labels/label-01.jpg /sdcard/Pictures/rx-test.jpg >/dev/null 2>&1 || true
adb shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Pictures/rx-test.jpg >/dev/null 2>&1 || true
adb logcat -c
if maestro test apps/carecircle/maestro/sign-in-magic-link.yaml && \
   maestro test apps/carecircle/maestro/invite-join-circle.yaml; then
  exit 0
fi
echo "::group::App log (ReactNativeJS, crashes)"
adb logcat -d -s ReactNativeJS:V ReactNative:V AndroidRuntime:E | tail -n 200
echo "::endgroup::"
echo "::group::Screen contents"
maestro hierarchy 2>/dev/null | grep -E '"(text|resource-id|accessibilityText)" : "[^"]+' -o | head -n 80
echo "::endgroup::"
exit 1
