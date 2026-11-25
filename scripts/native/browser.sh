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

# browse's extension lives here once browse-setup.sh has staged it. Without one, Chrome starts
# exactly as before.
EXT_ID="${BROWSE_EXTENSION_ID:-mfnicocicmmlkpjnaffgihfjhdgjkdjg}"
LAUNCH_STATE="$STATE/browser-launch.env"

if [ -z "$CHROME" ] || [ -z "$PROFILE" ] || [ -z "$CACHE" ]; then
  echo "[browser] set RAKAZO_NATIVE_CHROME_BIN, RAKAZO_NATIVE_BROWSER_PROFILE and RAKAZO_NATIVE_BROWSER_CACHE in .env" >&2
  exit 1
fi

EXT="$(readlink -f "$STATE/browse-extension/current" 2>/dev/null || true)"
# A copy installed from the Chrome Web Store in this profile. It is the fallback when a branded
# Chrome ignores --load-extension, so the flag that would switch it off is passed only when no
# such copy exists.
PROFILE_EXT=""
if [ -d "$PROFILE" ]; then
  PROFILE_EXT="$(find "$PROFILE" -maxdepth 4 -type d -name "$EXT_ID" 2>/dev/null | head -1)"
fi

ext_version() {
  grep -o '"version" *: *"[^"]*"' "$1/manifest.json" 2>/dev/null | head -1 |
    sed 's/.*: *"\([^"]*\)"/\1/'
}
newest_subdir() { find "$1" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -1; }

# Branded Chrome has ignored --load-extension in recent builds. Knowing the binary before the flags
# are chosen matters: for branded Chrome the store copy is the fallback, and
# --disable-extensions-except would switch exactly that copy off.
CHROME_VERSION=""
BRANDED=0
if [ -n "$EXT" ] && [ -f "$EXT/manifest.json" ]; then
  if command -v timeout >/dev/null 2>&1; then
    CHROME_VERSION="$(timeout 5 "$CHROME" --version 2>/dev/null || true)"
  else
    CHROME_VERSION="$("$CHROME" --version 2>/dev/null || true)"
  fi
  case "$CHROME_VERSION" in
    "" | *"for Testing"*) ;;
    *) BRANDED=1 ;;
  esac
fi

EXTS=()
LAUNCH_MODE="none"
LAUNCH_PATH=""
LAUNCH_VERSION=""
if [ -n "$EXT" ] && [ -f "$EXT/manifest.json" ]; then
  EXTS+=(--load-extension="$EXT")
  if [ "$BRANDED" -eq 1 ]; then
    echo "[browser] branded Chrome: no extension restriction, so a store install can load too"
  elif [ -z "$PROFILE_EXT" ]; then
    EXTS+=(--disable-extensions-except="$EXT")
  else
    echo "[browser] profile also holds a store install; keeping it loadable as a fallback"
  fi
  LAUNCH_MODE="unpacked"
  LAUNCH_PATH="$EXT"
  LAUNCH_VERSION="$(ext_version "$EXT")"
elif [ -n "$PROFILE_EXT" ]; then
  LAUNCH_MODE="store"
  LAUNCH_PATH="$PROFILE_EXT"
  newest="$(newest_subdir "$PROFILE_EXT")"
  [ -n "$newest" ] && LAUNCH_VERSION="$(basename "$newest")"
fi

# With no store copy in the profile there is nothing to fall back to, so say it here, where it can
# be fixed, instead of leaving browse to fail later without a clue.
if [ "$BRANDED" -eq 1 ] && [ -z "$PROFILE_EXT" ]; then
  echo "[browser] warning: $CHROME is branded Chrome, which may ignore --load-extension." >&2
  echo "[browser] if browse stays disconnected, install OpenCode Browse from the Chrome Web" >&2
  echo "[browser] Store once in $PROFILE; the next launch loads that copy." >&2
fi

# What browse-setup.sh compares against the staged copy: an exact record beats guessing from files.
write_launch_state() {
  local tmp="$LAUNCH_STATE.tmp"
  mkdir -p "$STATE"
  {
    printf 'mode=%s\n' "$LAUNCH_MODE"
    printf 'path=%s\n' "$LAUNCH_PATH"
    printf 'version=%s\n' "$LAUNCH_VERSION"
    printf 'startedAt=%s\n' "$(date +%s)"
  } >"$tmp"
  mv "$tmp" "$LAUNCH_STATE"
  chmod 600 "$LAUNCH_STATE"
}

# start.sh and the desktop autostart both call this script. Serialize them: the loser would see the
# port already open and exit, or write a pid for a Chrome that quit under the profile lock.
if command -v flock >/dev/null 2>&1; then
  mkdir -p "$STATE"
  exec 9>"$STATE/browser.lock"
  flock 9
fi

if curl -sf -m 2 "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
  echo "[browser] already running on 127.0.0.1:${PORT}"
  exit 0
fi

mkdir -p "$PROFILE" "$CACHE"
chmod 700 "$PROFILE" "$CACHE" 2>/dev/null || true
# Chromium writes "DevTools listening on ws://..." here, which is control of this browser (and the
# logins in its profile). umask 077 sets the mode only when the file is created, so a copy made by
# an older run stays whatever it was: set 600 explicitly before it is opened again.
mkdir -p "$STATE"
: >>"$LOG"
chmod 600 "$LOG"
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
  "${EXTS[@]}" \
  --disk-cache-dir="$CACHE" \
  --no-first-run \
  --no-default-browser-check \
  about:blank >"$LOG" 2>&1 9>&- &
# 9>&- keeps the start lock out of Chrome: an inherited descriptor would hold it for as long as the
# browser lives, and the next call would wait instead of saying it is already running.
BROWSER_PID=$!

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
    # The pid reaches the file only once the port answers, so a Chrome that quit at startup never
    # leaves a pid behind for browser-stop.sh to trust.
    echo "$BROWSER_PID" >"$PIDFILE"
    write_launch_state
    echo "[browser] ready"
    exit 0
  fi
  sleep 0.5
done
if kill -0 "$BROWSER_PID" 2>/dev/null; then
  echo "$BROWSER_PID" >"$PIDFILE"
fi
# No launch record for a browser that never answered: a stale one would tell browse-setup.sh the
# wrong copy is running.
rm -f "$LAUNCH_STATE"
echo "[browser] Chromium did not answer on 127.0.0.1:${PORT}; see $LOG" >&2
exit 1
