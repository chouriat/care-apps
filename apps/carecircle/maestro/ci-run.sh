#!/usr/bin/env bash
# CI only: install the release APK on the booted emulator and run the Maestro flows.
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
adb shell pm grant app.carecircle.mobile android.permission.CAMERA >/dev/null 2>&1 || true
adb shell pm grant app.carecircle.mobile android.permission.READ_MEDIA_IMAGES >/dev/null 2>&1 || true
adb shell pm grant app.carecircle.mobile android.permission.READ_EXTERNAL_STORAGE >/dev/null 2>&1 || true
python3 - <<'PY'
import base64
jpeg_b64 = (
    "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAA"
    "A6ABAAMAAAABAAEAAKACAAQAAAABAAAAQKADAAQAAAABAAAAQAAAAAD/7QA4UGhvdG9zaG9wIDMu"
    "MAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAQABAAwEiAAIR"
    "AQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAAB"
    "fQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5"
    "OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeo"
    "qaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMB"
    "AQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYS"
    "QVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNU"
    "VVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5"
    "usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMF"
    "BgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgIC"
    "BAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ"
    "EBAQEP/dAAQABP/aAAwDAQACEQMRAD8A/cCiiigAooooAKKKKACiiigD/9D9wKKKKACiiigAoooo"
    "AKKKKAP/0f3AooooAKKKKACiiigAooooA//S/cCiiigAooooAKKKKACiiigD/9k="
)
open("/tmp/rx-test.jpg", "wb").write(base64.b64decode(jpeg_b64))
PY
adb push /tmp/rx-test.jpg /sdcard/Pictures/rx-test.jpg >/dev/null 2>&1 || true
adb push /tmp/rx-test.jpg /sdcard/DCIM/Camera/rx-test.jpg >/dev/null 2>&1 || true
adb shell content call --uri content://media/ --method scan_file --arg /sdcard/Pictures/rx-test.jpg >/dev/null 2>&1 || true
adb shell content call --uri content://media/ --method scan_file --arg /sdcard/DCIM/Camera/rx-test.jpg >/dev/null 2>&1 || true
adb shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Pictures/rx-test.jpg >/dev/null 2>&1 || true
# Grant Family entitlement in the local CI DB only for the visit-note-typed.yaml test user so
# summarizeVisit passes the server-side Family plan check during the Maestro E2E run.
DB_CONTAINER="$(docker ps --filter 'name=supabase_db' --format '{{.Names}}' | head -n 1)"
if [ -n "$DB_CONTAINER" ]; then
  docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres >/dev/null 2>&1 <<'SQL' || true
create or replace function public.ci_auto_grant_family_for_visit_e2e()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email = 'caregiver-visit@example.com' then
    insert into public.entitlements (user_id, entitlement, active)
    values (new.id, 'carecircle_family', true)
    on conflict (user_id, entitlement) do update set active = true;
  end if;
  return new;
end;
$$;
drop trigger if exists ci_auto_grant_family_trigger on auth.users;
create trigger ci_auto_grant_family_trigger
  after insert on auth.users
  for each row
  execute function public.ci_auto_grant_family_for_visit_e2e();
SQL
fi
adb logcat -c
if maestro test apps/carecircle/maestro/sign-in-magic-link.yaml && \
   maestro test apps/carecircle/maestro/invite-join-circle.yaml && \
   maestro test apps/carecircle/maestro/meds-crud.yaml && \
   maestro test apps/carecircle/maestro/scan-confirm.yaml && \
   maestro test apps/carecircle/maestro/visit-note-typed.yaml && \
   maestro test apps/carecircle/maestro/appointments-crud.yaml && \
   maestro test apps/carecircle/maestro/tasks-crud.yaml; then
  exit 0
fi
echo "::group::App log (ReactNativeJS, crashes)"
adb logcat -d -s ReactNativeJS:V ReactNative:V AndroidRuntime:E | tail -n 200
echo "::endgroup::"
echo "::group::Functions serve log"
cat /tmp/functions-serve.log 2>/dev/null | tail -n 100 || true
echo "::endgroup::"
echo "::group::Screen contents"
# Indented by nesting depth, so a failed `childOf` check shows which element holds which.
maestro hierarchy 2>/dev/null > /tmp/maestro-hierarchy.json
python3 - /tmp/maestro-hierarchy.json <<'PY' | head -n 120
import json, sys
text = open(sys.argv[1]).read()
root = json.loads(text[text.index('{'):])
def walk(node, depth):
    a = node.get('attributes', {})
    parts = [f'{k}={a[k]!r}' for k in ('resource-id', 'text', 'accessibilityText') if a.get(k)]
    if parts:
        print('  ' * depth + ' '.join(parts) + f" {a.get('bounds', '')}")
    for child in node.get('children', []):
        walk(child, depth + 1)
walk(root, 0)
PY
echo "::endgroup::"
exit 1
