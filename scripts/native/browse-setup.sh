#!/usr/bin/env bash
# Prepares browse for the shared Chromium: the CLI, the extension the browser loads, the pairing
# with the relay, and the autostart entry that brings the browser back after a login.
#
#   bash scripts/native/browse-setup.sh
#   bash scripts/native/browse-setup.sh --no-pair --no-autostart
#   bash scripts/native/browse-setup.sh --wait-seconds 45
#
# Safe to rerun. It keeps a working CLI, keeps an existing pairing, and only restarts the shared
# browser when the extension did not load into it.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE="$HOME/.local/share/rakazo-native"
EXT_DIR="$STATE/browse-extension"
CLI_DIR="$STATE/browse"
STATUS="$STATE/browse-status.json"
PAIR_LOG="$STATE/browse-pair.log"
AUTOSTART="$HOME/.config/autostart/rakazo-browser.desktop"

PAIR=1
AUTOSTART_ON=1
WAIT=60
while [ $# -gt 0 ]; do
  case "$1" in
    --no-pair) PAIR=0 ;;
    --no-autostart) AUTOSTART_ON=0 ;;
    --wait-seconds)
      WAIT="${2:?--wait-seconds needs a value}"
      shift
      ;;
    -h | --help)
      sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "[browse] unknown option: $1" >&2
      exit 2
      ;;
  esac
  shift
done

read_env() {
  local name="$1"
  local from_file
  from_file="$(grep -E "^${name}=" "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)"
  printf '%s' "${!name:-$from_file}"
}

PORT="$(read_env RAKAZO_NATIVE_BROWSER_PORT)"; PORT="${PORT:-9222}"
EXT_ID="${BROWSE_EXTENSION_ID:-mfnicocicmmlkpjnaffgihfjhdgjkdjg}"
STORE_URL="https://chromewebstore.google.com/detail/${EXT_ID}"

mkdir -p "$STATE" "$CLI_DIR" "$EXT_DIR"
chmod 700 "$STATE" "$CLI_DIR" "$EXT_DIR" 2>/dev/null || true

# --- CLI ---------------------------------------------------------------------
# An installed browse is preferred: this host already runs one that talks to its relay. Only a
# host without any gets one here, from npm, into $CLI_DIR, so nothing needs root.
resolve_cli() {
  local candidate
  for candidate in "${BROWSE_BIN:-}" "$HOME/.local/bin/browse" "$CLI_DIR/node_modules/.bin/browse"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

if ! BROWSE="$(resolve_cli)"; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "[browse] no browse command and no npm; install it from $STORE_URL (browse latest) or set BROWSE_BIN" >&2
    exit 1
  fi
  echo "[browse] installing the browse CLI in $CLI_DIR"
  npm i --prefix "$CLI_DIR" --no-audit --no-fund --loglevel=error \
    "@opencode/browse@${BROWSE_CLI_VERSION:-0.1.5}"
  BROWSE="$CLI_DIR/node_modules/.bin/browse"
  [ -x "$BROWSE" ] || {
    echo "[browse] npm install did not produce $BROWSE" >&2
    exit 1
  }
fi
CLI_VERSION="$("$BROWSE" --version 2>/dev/null | head -1 || true)"
echo "[browse] cli $CLI_VERSION at $BROWSE"

# --- extension ---------------------------------------------------------------
# browse ships the extension through the Chrome Web Store, so there is nothing here to download:
# the script adopts a copy that already exists on this machine. A version already staged is
# compared with the browser's own copy, and the newer one wins, so upgrading the extension in the
# browser and rerunning this script is what picks the upgrade up.
version_key() {
  local base
  base="$(basename "$1")"
  printf '%s' "${base%%_*}"
}

BEST_SRC=""
BEST_KEY=""
consider_src() {
  local dir="$1"
  [ -n "$dir" ] && [ -f "$dir/manifest.json" ] || return 0
  local key
  key="$(version_key "$dir")"
  if [ -z "$BEST_SRC" ]; then
    BEST_SRC="$dir"
    BEST_KEY="$key"
    return 0
  fi
  if [ "$key" != "$BEST_KEY" ] &&
    [ "$(printf '%s\n%s\n' "$BEST_KEY" "$key" | sort -V | tail -1)" = "$key" ]; then
    BEST_SRC="$dir"
    BEST_KEY="$key"
  fi
}

consider_src "${BROWSE_EXTENSION_SRC:-}"
if [ -d "$EXT_DIR" ]; then
  while IFS= read -r dir; do
    consider_src "$dir"
  done < <(find "$EXT_DIR" -mindepth 1 -maxdepth 1 -type d ! -name current 2>/dev/null | sort)
fi
for base in "$HOME/.config/google-chrome/Default/Extensions" "$HOME/.config/chromium/Default/Extensions"; do
  if [ -d "$base/$EXT_ID" ]; then
    while IFS= read -r dir; do
      consider_src "$dir"
    done < <(find "$base/$EXT_ID" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)
  fi
done

if [ -z "$BEST_SRC" ]; then
  echo "[browse] no unpacked extension found. Install \"OpenCode Browse\" from $STORE_URL" >&2
  echo "[browse] in the shared browser once, then rerun this script, or pass the folder:" >&2
  echo "[browse]   BROWSE_EXTENSION_SRC=/path/to/extension bash scripts/native/browse-setup.sh" >&2
  exit 1
fi

EXT_STAGED="$EXT_DIR/$(basename "$BEST_SRC")"
if [ ! -f "$EXT_STAGED/manifest.json" ]; then
  echo "[browse] staging the extension from $BEST_SRC"
  cp -a "$BEST_SRC" "$EXT_STAGED"
fi
# Rebuild the link from scratch: renaming over a symlink that points at itself is how a loop is born.
rm -f "$EXT_DIR/current"
ln -s "$EXT_STAGED" "$EXT_DIR/current"
EXT_PATH="$(readlink -f "$EXT_DIR/current")"

if ! grep -q '"name": "OpenCode Browse"' "$EXT_PATH/manifest.json"; then
  echo "[browse] $EXT_PATH/manifest.json is not the OpenCode Browse extension" >&2
  exit 1
fi
EXT_VERSION="$(sed -n 's/^ *"version": "\([^"]*\)".*/\1/p' "$EXT_PATH/manifest.json" | head -1)"
echo "[browse] extension $(basename "$EXT_PATH") at $EXT_PATH"

write_status() {
  local code="${1:-}" expires="${2:-}" tmp="$STATUS.tmp"
  {
    printf '{\n'
    printf '  "cli": "%s",\n' "$BROWSE"
    printf '  "cliVersion": "%s",\n' "$CLI_VERSION"
    printf '  "relayPort": %s,\n' "$PORT"
    printf '  "extensionId": "%s",\n' "$EXT_ID"
    printf '  "extensionPath": "%s",\n' "$EXT_PATH"
    printf '  "extensionVersion": "%s",\n' "$EXT_VERSION"
    printf '  "pairingCode": "%s",\n' "$code"
    printf '  "pairingCodeExpiresAt": "%s",\n' "$expires"
    printf '  "updatedAt": "%s"\n' "$(date -Is)"
    printf '}\n'
  } >"$tmp"
  mv "$tmp" "$STATUS"
  chmod 600 "$STATUS"
}

# --- shared browser ----------------------------------------------------------
browser_up() { curl -sf -m 2 "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; }

# The id the running browser actually loaded, which is what the onboarding page must be opened on.
loaded_extension_id() {
  load_extension_targets | head -1 | sed 's|^chrome-extension://||'
}

load_extension_targets() {
  curl -s -m 2 "http://127.0.0.1:${PORT}/json/list" 2>/dev/null |
    grep -o 'chrome-extension://[a-p]\{32\}' | sort -u || true
}

open_tab() {
  curl -s -m 5 -X PUT "http://127.0.0.1:${PORT}/json/new?$1" 2>/dev/null || true
}

tab_id_of() {
  printf '%s' "$1" | grep -o '"id": *"[^"]*"' | head -1 | cut -d'"' -f4
}

close_tab() {
  [ -n "${1:-}" ] && curl -s -m 5 "http://127.0.0.1:${PORT}/json/close/${1}" >/dev/null 2>&1 || true
}

extension_loaded() {
  [ -n "$(load_extension_targets)" ]
}

if ! browser_up; then
  bash "$ROOT/scripts/native/browser.sh"
fi

# A service worker sleeps, so ask the extension for a page before deciding it is missing. A browser
# that was already running from before the extension was installed otherwise fails silently later.
if ! extension_loaded; then
  WAKE_TAB="$(tab_id_of "$(open_tab "chrome-extension://${EXT_ID}/onboarding.html")")"
  for _ in $(seq 1 10); do
    extension_loaded && break
    sleep 0.5
  done
  close_tab "$WAKE_TAB"
fi
if ! extension_loaded; then
  echo "[browse] the shared browser started without the extension; restarting it"
  bash "$ROOT/scripts/native/browser-stop.sh" >/dev/null 2>&1 || true
  bash "$ROOT/scripts/native/browser.sh"
  WAKE_TAB="$(tab_id_of "$(open_tab "chrome-extension://${EXT_ID}/onboarding.html")")"
  for _ in $(seq 1 10); do
    extension_loaded && break
    sleep 0.5
  done
  close_tab "$WAKE_TAB"
fi
if ! extension_loaded; then
  echo "[browse] the shared browser on 127.0.0.1:${PORT} did not load $EXT_PATH" >&2
  echo "[browse] check that this Chrome still honours --load-extension, or install the extension" >&2
  echo "[browse] from $STORE_URL in that browser's profile" >&2
  exit 1
fi

# --- pairing -----------------------------------------------------------------
paired() { "$BROWSE" status 2>/dev/null | grep -q '^Extension: connected'; }

if [ "$PAIR" -eq 1 ] && ! paired; then
  echo "[browse] pairing the shared browser with the relay"
  : >"$PAIR_LOG"
  "$BROWSE" pair --wait-seconds "$WAIT" >"$PAIR_LOG" 2>&1 &
  PAIR_PID=$!

  CODE=""
  for _ in $(seq 1 60); do
    CODE="$(sed -n 's/^Pairing code: *//p' "$PAIR_LOG" 2>/dev/null | head -1)"
    [ -n "$CODE" ] && break
    sleep 0.5
  done

  if [ -z "$CODE" ]; then
    wait "$PAIR_PID" 2>/dev/null || true
    echo "[browse] browse pair printed no pairing code; see $PAIR_LOG" >&2
    write_status
    exit 1
  fi

  # The code is written down before it is printed: it stays readable at $STATUS for ten minutes,
  # and the operator only ever sees it once.
  write_status "$CODE" "$(date -d '+10 minutes' -Is)"
  echo "[browse] pairing code: $CODE (also in $STATUS, valid 10 minutes)"

  ID="$(loaded_extension_id)"
  ID="${ID:-$EXT_ID}"
  # A fragment cannot travel in a query string unencoded, and the onboarding page reads location.hash.
  ONBOARDING="chrome-extension://${ID}/onboarding.html%23code=${CODE}"
  # The page redeems the code from its own JavaScript, so it stays open while the relay answers.
  PAIR_TAB="$(tab_id_of "$(open_tab "$ONBOARDING")")"

  CONNECTED=0
  for _ in $(seq 1 "$WAIT"); do
    if paired; then
      CONNECTED=1
      break
    fi
    sleep 1
  done
  wait "$PAIR_PID" 2>/dev/null || true

  if [ "$CONNECTED" -ne 1 ]; then
    # The tab stays open on failure: its page is the place the code is meant to be confirmed.
    echo "[browse] pairing was not confirmed. Enter $CODE under browse's Options -> advanced" >&2
    echo "[browse] (or click Pair with a code) in the shared browser, then rerun this script." >&2
    exit 1
  fi
  close_tab "$PAIR_TAB"
  write_status
elif [ "$PAIR" -eq 0 ] && ! paired; then
  echo "[browse] skipped pairing (--no-pair); run this script again when the code should be redeemed"
  write_status
else
  write_status
fi

# The extension opens its own onboarding page on every start until it is dismissed. Left there it
# competes with the page a bot is asked to drive, so a connected browser gets it closed.
close_onboarding_tabs() {
  local tab
  while IFS= read -r tab; do
    close_tab "$tab"
  done < <(
    curl -s -m 2 "http://127.0.0.1:${PORT}/json/list" 2>/dev/null |
      node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{for(const t of JSON.parse(s))if(t.type==="page"&&t.url.includes("/onboarding.html"))console.log(t.id)}catch{}})'
  )
}

# --- autostart ---------------------------------------------------------------
# A desktop entry, not a systemd unit: the browser must inherit the graphical session to be a
# normal headful Chrome, and that is what keeps the Google login it signs in with.
if [ "$AUTOSTART_ON" -eq 1 ]; then
  mkdir -p "$(dirname "$AUTOSTART")"
  cat >"$AUTOSTART" <<EOF
[Desktop Entry]
Type=Application
Name=Rakazo shared browser
Comment=Chromium on 127.0.0.1:${PORT} that bots drive through browse
Exec=/bin/bash "$ROOT/scripts/native/browser.sh"
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
EOF
  chmod 600 "$AUTOSTART"
  echo "[browse] autostart: $AUTOSTART"
fi

# --- report ------------------------------------------------------------------
if paired; then
  close_onboarding_tabs
fi
# Names are not proof: the shared browser's own name depends on what it was paired as, so the
# Extension line below is the one that says whether a bot can drive it.
PAIRED_COUNT="$("$BROWSE" pair --list 2>/dev/null | grep -cE '^[^[:space:]]' || true)"
echo "[browse] paired browsers: ${PAIRED_COUNT:-0} ($BROWSE pair --list)"
"$BROWSE" status 2>/dev/null | grep -E '^(Relay|Extension):' || true
