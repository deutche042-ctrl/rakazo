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
# A real headful Chrome, as openbot runs, reports a normal Chrome UA. Headless reports
# "HeadlessChrome", which Google refuses to sign in. Use the display when there is one.
MODE=(--window-size=1280,900 --window-position=0,0)
if [ -n "${DISPLAY:-}" ]; then
  # Chrome 158 otherwise picks Wayland and warns that it is incompatible with Vulkan.
  MODE+=(--ozone-platform=x11)
elif [ -n "${WAYLAND_DISPLAY:-}" ]; then
  MODE+=(--ozone-platform=wayland)
fi
if [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  MODE=(--headless=new --disable-gpu)
  echo "[browser] mode: headless (no display)"
else
  echo "[browser] mode: headful (${DISPLAY:-$WAYLAND_DISPLAY})"
fi
nohup "$CHROME" \
  "${MODE[@]}" \
  --remote-debugging-port="$PORT" \
  --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$PROFILE" \
  --disk-cache-dir="$CACHE" \
  --no-first-run \
  --no-default-browser-check \
  about:blank >"$LOG" 2>&1 &
echo $! > "$PIDFILE"

for _ in $(seq 1 60); do
  if curl -sf -m 1 "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
    # A headless launch can come up with no page target after a restored profile; the helper and
    # the panel both need one, so create it explicitly.
    for _ in $(seq 1 20); do
      if curl -s -m 1 "http://127.0.0.1:${PORT}/json/list" 2>/dev/null | grep -q '"type": *"page"'; then
        break
      fi
      curl -s -m 2 -X PUT "http://127.0.0.1:${PORT}/json/new?about:blank" >/dev/null 2>&1 || true
      sleep 0.5
    done
    echo "[browser] ready"
    exit 0
  fi
  sleep 0.5
done
echo "[browser] Chromium did not answer on 127.0.0.1:${PORT}; see $LOG" >&2
exit 1
