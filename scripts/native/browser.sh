#!/usr/bin/env bash
# Starts the one Chromium every bot shares, on a loopback CDP port.
# Called by start.sh; safe to rerun.
#
# Chrome writes cookies, logins and localStorage at shutdown, so stop it with
# browser-stop.sh (SIGTERM, then wait) rather than killing the process.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE="$HOME/.local/share/rakazo-native"
PIDFILE="$STATE/browser.pid"
LOG="$STATE/browser.log"

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
  echo "[browser] set RAKAZO_NATIVE_CHROME_BIN, RAKAZO_NATIVE_BROWSER_PROFILE and RAKAZO_NATIVE_BROWSER_CACHE in .env" >&2
  exit 1
fi

if curl -sf -m 2 "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
  echo "[browser] already running on 127.0.0.1:${PORT}"
  exit 0
fi

mkdir -p "$PROFILE" "$CACHE"
chmod 700 "$PROFILE" "$CACHE" 2>/dev/null || true
echo "[browser] starting Chromium on 127.0.0.1:${PORT}"
nohup "$CHROME" \
  --headless=new \
  --remote-debugging-port="$PORT" \
  --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$PROFILE" \
  --disk-cache-dir="$CACHE" \
  --no-first-run \
  --no-default-browser-check \
  --disable-gpu \
  --window-size=1280,900 \
  about:blank >"$LOG" 2>&1 &
echo $! > "$PIDFILE"

for _ in $(seq 1 60); do
  if curl -sf -m 1 "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
    echo "[browser] ready"
    exit 0
  fi
  sleep 0.5
done
echo "[browser] Chromium did not answer on 127.0.0.1:${PORT}; see $LOG" >&2
exit 1
