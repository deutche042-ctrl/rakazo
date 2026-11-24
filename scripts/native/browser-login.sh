#!/usr/bin/env bash
# Signs in to Google in a real window, then hands the session back to the shared browser.
#
# Google refuses a sign-in from an automated (headless) browser. This stops the shared Chromium so
# the same profile can be opened in a normal window, waits while the user signs in and closes it,
# then restarts the shared browser on that profile, which keeps the session.
#
#   bash scripts/native/browser-login.sh
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE="$HOME/.local/share/rakazo-native"
PIDFILE="$STATE/browser.pid"
LOG="$STATE/browser-login.log"

read_env() {
  local name="$1"
  local from_file
  from_file="$(grep -E "^${name}=" "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)"
  printf '%s' "${!name:-$from_file}"
}

PORT="$(read_env RAKAZO_NATIVE_BROWSER_PORT)"; PORT="${PORT:-9222}"
CHROME="$(read_env RAKAZO_NATIVE_CHROME_BIN)"
PROFILE="$(read_env RAKAZO_NATIVE_BROWSER_PROFILE)"
CACHE="$(read_env RAKAZO_NATIVE_BROWSER_CACHE)"

if [ -z "$CHROME" ] || [ -z "$PROFILE" ] || [ -z "$CACHE" ]; then
  echo "[login] set RAKAZO_NATIVE_CHROME_BIN, RAKAZO_NATIVE_BROWSER_PROFILE and RAKAZO_NATIVE_BROWSER_CACHE in .env" >&2
  exit 1
fi

LOGIN_PID=""
STOPPED=0
CLEANED=0

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

# Whatever way this script ends, the shared browser comes back once it had been stopped.
cleanup() {
  [ "$CLEANED" -eq 0 ] || return 0
  CLEANED=1
  stop_login
  if [ "$STOPPED" -eq 1 ]; then
    STOPPED=0
    echo "[login] restarting the shared browser"
    bash "$ROOT/scripts/native/browser.sh"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Stop the headless browser gracefully, so Chrome writes cookies and logins to the profile.
if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE")"
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "[login] shared browser is not running"
  elif [ -r "/proc/$PID/cmdline" ] && ! tr '\0' ' ' <"/proc/$PID/cmdline" | grep -qF -- "--user-data-dir=$PROFILE"; then
    # A stale pid file can name an unrelated process after a reboot. Signal only this browser.
    echo "[login] pid $PID is not this browser; dropping the stale pid file"
  else
    echo "[login] stopping the shared browser ($PID)"
    kill -TERM "$PID" 2>/dev/null || true
    for _ in $(seq 1 30); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$PID" 2>/dev/null; then
      echo "[login] still running after 30s; killing it"
      kill -KILL "$PID" 2>/dev/null || true
      for _ in $(seq 1 10); do
        kill -0 "$PID" 2>/dev/null || break
        sleep 0.5
      done
    fi
  fi
  rm -f "$PIDFILE"
else
  echo "[login] no pid file; the shared browser is not running"
fi

# The profile cannot be opened twice, so wait for the CDP port to close as well.
for _ in $(seq 1 20); do
  curl -sf -m 1 "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1 || break
  sleep 0.5
done
if curl -sf -m 1 "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
  echo "[login] something still answers on 127.0.0.1:${PORT}; stop it before signing in" >&2
  exit 1
fi
STOPPED=1

mkdir -p "$PROFILE" "$CACHE"
chmod 700 "$PROFILE" "$CACHE" 2>/dev/null || true
export DISPLAY="${DISPLAY:-:0}"

echo "[login] opening Chromium in a real window on DISPLAY=$DISPLAY"
echo "[login] Sign in to Google in the window, then close it; the shared browser restarts and keeps the session."
# No --headless and no --remote-debugging-port: this is an ordinary browser window on the same
# profile, so the sign-in is a human one.
"$CHROME" \
  --user-data-dir="$PROFILE" \
  --disk-cache-dir="$CACHE" \
  --no-first-run \
  --no-default-browser-check \
  --disable-gpu \
  --window-size=1280,900 \
  about:blank >"$LOG" 2>&1 &
LOGIN_PID=$!
# Waits for as long as the window stays open.
wait "$LOGIN_PID" || true
if kill -0 "$LOGIN_PID" 2>/dev/null; then
  echo "[login] interrupted before the window closed" >&2
  exit 130
fi
LOGIN_PID=""

echo "[login] window closed"
