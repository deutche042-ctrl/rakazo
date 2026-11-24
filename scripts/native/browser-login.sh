#!/usr/bin/env bash
# Signs in to Google in a real window, then hands the session back to the shared browser.
#
# Google refuses a sign-in from an automated browser. This stops the shared Chromium so the same
# profile can be opened in an ordinary Google Chrome window, waits while the user signs in and
# closes it, then restarts the shared browser on that profile, which keeps the session.
#
#   bash scripts/native/browser-login.sh
#
# Exit: 0 a Google session was verified, 2 a prerequisite is missing, 3 no Google session / Google
# refused the browser / the session could not be verified, 4 Chrome failed to start or close cleanly.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE="$HOME/.local/share/rakazo-native"
LOG="$STATE/browser-login.log"

read_env() {
  local name="$1"
  local from_file
  from_file="$(grep -E "^${name}=" "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)"
  printf '%s' "${!name:-$from_file}"
}

PORT="$(read_env RAKAZO_NATIVE_BROWSER_PORT)"; PORT="${PORT:-9222}"
PROFILE="$(read_env RAKAZO_NATIVE_BROWSER_PROFILE)"
CACHE="$(read_env RAKAZO_NATIVE_BROWSER_CACHE)"

if [ -z "$PROFILE" ] || [ -z "$CACHE" ]; then
  echo "[login] exit 2: set RAKAZO_NATIVE_BROWSER_PROFILE and RAKAZO_NATIVE_BROWSER_CACHE in .env" >&2
  exit 2
fi

chrome_version() { "$1" --version 2>/dev/null || true; }

# Chrome for Testing is an automated build; Google treats it as one and may refuse the sign-in.
is_chrome_for_testing() {
  case "$(chrome_version "$1")" in
    *"for Testing"*) return 0 ;;
  esac
  return 1
}

# The sign-in window runs on real Google Chrome. The configured shared browser is the last resort,
# because that one is often Chrome for Testing and is refused below.
LOGIN_CHROME_OVERRIDE="$(read_env RAKAZO_NATIVE_LOGIN_CHROME_BIN)"
SHARED_CHROME="$(read_env RAKAZO_NATIVE_CHROME_BIN)"
find_login_chrome() {
  local candidate
  for candidate in \
    "$LOGIN_CHROME_OVERRIDE" \
    "$(command -v google-chrome-stable 2>/dev/null || true)" \
    "$(command -v google-chrome 2>/dev/null || true)" \
    "/opt/google/chrome/chrome" \
    "$STATE/tools/chrome-stable/opt/google/chrome/chrome" \
    "$SHARED_CHROME"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

LOGIN_CHROME="$(find_login_chrome || true)"
if [ -z "$LOGIN_CHROME" ]; then
  echo "[login] exit 2: no Google Chrome found. Install it once with: bash scripts/native/install-chrome.sh" >&2
  exit 2
fi
if is_chrome_for_testing "$LOGIN_CHROME" && [ "${RAKAZO_NATIVE_ALLOW_CFT_LOGIN:-0}" != "1" ]; then
  echo "[login] exit 2: $LOGIN_CHROME is a Chrome for Testing build; Google may refuse its sign-in." >&2
  echo "[login] install real Google Chrome with: bash scripts/native/install-chrome.sh" >&2
  echo "[login] RAKAZO_NATIVE_ALLOW_CFT_LOGIN=1 is for a diagnostic run only." >&2
  exit 2
fi
case "$(chrome_version "$LOGIN_CHROME")" in
  *"Google Chrome"*) ;;
  *) echo "[login] warning: $LOGIN_CHROME is not Google Chrome; Google may refuse the sign-in." >&2 ;;
esac

# A sign-in window needs a screen. An empty display is a service started without one, not a reason
# to guess :0, which would fail after the browser had already been stopped.
if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  echo "[login] exit 2: no graphical session: DISPLAY and WAYLAND_DISPLAY are both empty." >&2
  echo "[login] run this from a terminal in the host's desktop session, where the display is set." >&2
  echo "[login] a stack started without a display keeps the shared browser headless." >&2
  exit 2
fi

LOGIN_PID=""
STOPPED=0
CLEANED=0
# Filled by google_session_present: the number of session cookies found and, on a failed check,
# what stopped the check. Cookie values are never read into these.
GOOGLE_SESSION_COOKIES=0
GOOGLE_SESSION_PROBLEM=""

# A login window still open when this script ends (Ctrl+C, a failure) is closed first.
stop_login() {
  if [ -n "$LOGIN_PID" ] && kill -0 "$LOGIN_PID" 2>/dev/null; then
    kill -TERM "$LOGIN_PID" 2>/dev/null || true
    for _ in $(seq 1 10); do
      kill -0 "$LOGIN_PID" 2>/dev/null || break
      sleep 0.5
    done
    kill -KILL "$LOGIN_PID" 2>/dev/null || true
    wait "$LOGIN_PID" 2>/dev/null || true
  fi
  LOGIN_PID=""
}

# True when the profile holds a Google session cookie. The values are never printed.
# Returns 2 when the check itself is impossible, so the caller does not report a success it cannot see.
google_session_present() {
  local source tmp count
  GOOGLE_SESSION_COOKIES=0
  GOOGLE_SESSION_PROBLEM=""
  if ! command -v sqlite3 >/dev/null 2>&1; then
    GOOGLE_SESSION_PROBLEM="sqlite3 is not installed"
    echo "[login] sqlite3 is not installed, so the Google session cannot be verified." >&2
    echo "[login] install sqlite3 (sudo apt-get install -y sqlite3) and run this again." >&2
    return 2
  fi
  if [ -f "$PROFILE/Default/Network/Cookies" ]; then
    source="$PROFILE/Default/Network/Cookies"
  elif [ -f "$PROFILE/Default/Cookies" ]; then
    source="$PROFILE/Default/Cookies"
  else
    GOOGLE_SESSION_PROBLEM="the profile has no cookie database"
    echo "[login] the profile has no cookie database at $PROFILE/Default" >&2
    return 1
  fi
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/rakazo-cookies.XXXXXX")"
  # Chrome writes the session at exit; the write-ahead log is part of the database until then.
  cp -f "$source" "$tmp/Cookies"
  for suffix in -wal -shm; do
    if [ -f "$source$suffix" ]; then cp -f "$source$suffix" "$tmp/Cookies$suffix"; fi
  done
  count="$(sqlite3 -readonly "$tmp/Cookies" \
    "select count(*) from cookies where host_key like '%google.com' and name in ('SID','HSID','SSID','APISID','SAPISID','__Secure-1PSID','__Secure-3PSID');" \
    2>/dev/null || true)"
  case "$tmp" in
    "${TMPDIR:-/tmp}"/rakazo-cookies.*) rm -rf -- "$tmp" ;;
  esac
  case "$count" in
    '' | *[!0-9]*)
      GOOGLE_SESSION_PROBLEM="the cookie database could not be read"
      echo "[login] the cookie database could not be read." >&2
      return 2
      ;;
  esac
  GOOGLE_SESSION_COOKIES="$count"
  if [ "$count" -gt 0 ]; then
    return 0
  fi
  GOOGLE_SESSION_PROBLEM="no Google session cookies"
  return 1
}

# Pids of other processes of this user that were started on the same profile. A second Chrome on a
# locked profile hands the URL to the first one and exits at once, which reads like a crash.
profile_owners() {
  local entry pid owners=""
  for entry in /proc/[0-9]*; do
    [ -O "$entry" ] || continue
    pid="${entry#/proc/}"
    [ "$pid" = "$$" ] && continue
    if [ -r "$entry/cmdline" ] &&
      tr '\0' '\n' <"$entry/cmdline" 2>/dev/null | grep -xF -- "--user-data-dir=$PROFILE" >/dev/null; then
      owners="$owners $pid"
    fi
  done
  printf '%s' "${owners# }"
}

# Whatever way this script ends, the shared browser comes back once it had been stopped.
cleanup() {
  local status=$?
  if [ "$CLEANED" -ne 0 ]; then exit "$status"; fi
  CLEANED=1
  trap - EXIT
  stop_login
  if [ "$STOPPED" -eq 1 ]; then
    STOPPED=0
    echo "[login] restarting the shared browser on the same profile"
    # The shared browser keeps the session only if it runs the browser the person signed in with.
    export RAKAZO_NATIVE_CHROME_BIN="$LOGIN_CHROME"
    if ! bash "$ROOT/scripts/native/browser.sh"; then
      echo "[login] the shared browser did not start with $LOGIN_CHROME; using the configured browser" >&2
      unset RAKAZO_NATIVE_CHROME_BIN
      if ! bash "$ROOT/scripts/native/browser.sh"; then
        echo "[login] the shared browser did not start at all; see $STATE/browser.log" >&2
      fi
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Stop the shared browser gracefully, so Chrome writes cookies and logins to the profile.
echo "[login] stopping the shared browser"
if ! bash "$ROOT/scripts/native/browser-stop.sh"; then
  echo "[login] exit 2: the shared browser did not stop, and it still owns the profile" >&2
  exit 2
fi
STOPPED=1

# The profile cannot be opened twice, so wait for the CDP port to close as well.
for _ in $(seq 1 20); do
  curl -sf -m 1 "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1 || break
  sleep 0.5
done
if curl -sf -m 1 "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
  echo "[login] exit 2: something still answers on 127.0.0.1:${PORT}; stop it before signing in" >&2
  exit 2
fi
# The shared browser is gone, but a login window from an earlier run may still own the profile.
PROFILE_OWNERS="$(profile_owners)"
if [ -n "$PROFILE_OWNERS" ]; then
  echo "[login] exit 2: another Chrome is still using this profile (pid $PROFILE_OWNERS)." >&2
  echo "[login] close that window and run this again; the shared browser restarts now." >&2
  exit 2
fi

mkdir -p "$PROFILE" "$CACHE"
chmod 700 "$PROFILE" "$CACHE" 2>/dev/null || true
PLATFORM_FLAG=()
if [ -n "${DISPLAY:-}" ]; then
  PLATFORM_FLAG=(--ozone-platform=x11)
elif [ -n "${WAYLAND_DISPLAY:-}" ]; then
  PLATFORM_FLAG=(--ozone-platform=wayland)
fi

echo "[login] opening Google Chrome on ${DISPLAY:-$WAYLAND_DISPLAY}"
echo "[login] this is a human step: sign in yourself in that window; the bot must not run or drive it."
echo "[login] a tab opens at https://accounts.google.com/ in a normal Chrome window."
echo "[login] enter your password only in that window, wait until your account appears, then close the whole window."
echo "[login] the shared browser then restarts on this profile and keeps the session."
# No --headless, no --remote-debugging-port and no automation flags: this is an ordinary browser
# window on the same profile, so the sign-in is a human one.
"$LOGIN_CHROME" \
  --user-data-dir="$PROFILE" \
  --disk-cache-dir="$CACHE" \
  --no-first-run \
  --no-default-browser-check \
  --window-size=1280,900 \
  "${PLATFORM_FLAG[@]}" \
  "https://accounts.google.com/" >"$LOG" 2>&1 &
LOGIN_PID=$!

# A browser that dies at once failed to launch; its status is the answer, not a sign-in.
sleep 2
if ! kill -0 "$LOGIN_PID" 2>/dev/null; then
  rc=0
  wait "$LOGIN_PID" || rc=$?
  LOGIN_PID=""
  echo "[login] exit 4: Google Chrome exited at once (status $rc); see $LOG:" >&2
  tail -n 20 "$LOG" >&2 || true
  exit 4
fi

# Waits for as long as the window stays open; its own status is kept, because a crash is not a sign-in.
rc=0
wait "$LOGIN_PID" || rc=$?
LOGIN_PID=""
if [ "$rc" -ne 0 ]; then
  echo "[login] exit 4: Google Chrome closed with status $rc; see $LOG:" >&2
  tail -n 20 "$LOG" >&2 || true
  exit 4
fi

if google_session_present; then
  echo "[login] verified: $GOOGLE_SESSION_COOKIES Google session cookie(s) are stored in $PROFILE"
  echo "[login] cookie values are never printed; the shared browser restarts on this profile."
  echo "[login] exit 0: the Google session is ready."
else
  status=$?
  if [ "$status" -eq 2 ]; then
    echo "[login] exit 3: the window closed, but the Google session could not be verified: $GOOGLE_SESSION_PROBLEM." >&2
    echo "[login] no success is reported without that check; inspect $PROFILE/Default and run again." >&2
    exit 3
  fi
  echo "[login] exit 3: the window closed without a Google session ($GOOGLE_SESSION_PROBLEM)." >&2
  echo "[login] If Google showed 'This browser or app may not be secure', it refused the browser:" >&2
  echo "[login] install real Google Chrome with scripts/native/install-chrome.sh, then run this once more." >&2
  echo "[login] Retrying the same window does not help." >&2
  exit 3
fi
