#!/usr/bin/env bash
# Stops the shared Chromium cleanly so cookies and logins reach disk.
# SIGTERM first; Chrome flushes its profile, then exits.
set -euo pipefail

STATE="$HOME/.local/share/rakazo-native"
PIDFILE="$STATE/browser.pid"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

read_env() {
  local name="$1"
  local from_file
  from_file="$(grep -E "^${name}=" "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)"
  printf '%s' "${!name:-$from_file}"
}

PROFILE="$(read_env RAKAZO_NATIVE_BROWSER_PROFILE)"

if [ ! -f "$PIDFILE" ]; then
  echo "[browser] no pid file"
  exit 0
fi

PID="$(cat "$PIDFILE")"
if ! kill -0 "$PID" 2>/dev/null; then
  echo "[browser] not running"
  rm -f "$PIDFILE"
  exit 0
fi

# A stale pid file can name an unrelated process after a reboot. Signal only the browser that
# serves this profile.
if [ -n "$PROFILE" ] && [ -r "/proc/$PID/cmdline" ]; then
  if ! tr '\0' ' ' <"/proc/$PID/cmdline" | grep -qF -- "--user-data-dir=$PROFILE"; then
    echo "[browser] pid $PID is not this browser; dropping the stale pid file"
    rm -f "$PIDFILE"
    exit 0
  fi
fi

echo "[browser] stopping $PID"
kill -TERM "$PID" 2>/dev/null || true
for _ in $(seq 1 30); do
  if ! kill -0 "$PID" 2>/dev/null; then
    rm -f "$PIDFILE"
    echo "[browser] stopped"
    exit 0
  fi
  sleep 1
done
echo "[browser] still running after 30s; leaving it for a later retry" >&2
exit 1
