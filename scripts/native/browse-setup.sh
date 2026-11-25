#!/usr/bin/env bash
# Prepares browse for the shared Chromium: the CLI, the extension the browser loads, the pairing
# with the relay, and the autostart entry that brings the browser back after a login.
#
#   bash scripts/native/browse-setup.sh
#   bash scripts/native/browse-setup.sh --no-pair --no-autostart
#   bash scripts/native/browse-setup.sh --wait-seconds 45
#   bash scripts/native/browse-setup.sh --no-download
#   bash scripts/native/browse-setup.sh --update-extension
#
# The extension is adopted from a copy already on this machine (the shared profile, another
# browser, a checkout) or, when there is none, downloaded from the Chrome Web Store.
# --update-extension skips the local copies and fetches the store package, which is how a staged
# copy whose browser install never updates itself gets replaced. Safe to rerun: it keeps a working
# CLI and an existing pairing, and restarts the shared browser only when the extension did not load
# or the copy it launched is not the staged one.
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
DOWNLOAD="${BROWSE_EXTENSION_DOWNLOAD:-1}"
UPDATE_EXT=0
WAIT=60
usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
}
while [ $# -gt 0 ]; do
  case "$1" in
    --no-pair) PAIR=0 ;;
    --no-autostart) AUTOSTART_ON=0 ;;
    --no-download) DOWNLOAD=0 ;;
    --update-extension)
      UPDATE_EXT=1
      DOWNLOAD=1
      ;;
    --wait-seconds)
      WAIT="${2:?--wait-seconds needs a value}"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "[browse] unknown option: $1" >&2
      exit 2
      ;;
  esac
  shift
done
# BROWSE_EXTENSION_DOWNLOAD=0/false both mean off; anything else keeps the default.
case "$DOWNLOAD" in
  0 | false | no | off) DOWNLOAD=0 ;;
  *) DOWNLOAD=1 ;;
esac

read_env() {
  local name="$1"
  local from_file
  from_file="$(grep -E "^${name}=" "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)"
  printf '%s' "${!name:-$from_file}"
}

PORT="$(read_env RAKAZO_NATIVE_BROWSER_PORT)"; PORT="${PORT:-9222}"
EXT_ID="${BROWSE_EXTENSION_ID:-mfnicocicmmlkpjnaffgihfjhdgjkdjg}"
STORE_URL="https://chromewebstore.google.com/detail/${EXT_ID}"
# The shared browser's profile. A Web Store install made in that window lands under it, and this
# script reads it on the next run: that is what lets the manual fallback finish instead of repeat.
PROFILE="$(read_env RAKAZO_NATIVE_BROWSER_PROFILE)"; PROFILE="${PROFILE:-$STATE/browser-profile}"
# browse's relay is local and fixed; pairing prints this only when it fails.
RELAY_PORT="${BROWSE_RELAY_PORT:-19988}"
# What browser.sh records about the copy it launched, so a staged upgrade is not missed.
LAUNCH_STATE="$STATE/browser-launch.env"

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
# browse ships the extension through the Chrome Web Store and not in its npm package, so the script
# adopts a copy that already exists on this machine, and fetches the store's own package when there
# is none. Every copy is compared by version and the newest wins, so upgrading the extension and
# rerunning this script is what picks the upgrade up.
manifest_version() {
  grep -o '"version" *: *"[^"]*"' "$1/manifest.json" 2>/dev/null | head -1 |
    sed 's/.*: *"\([^"]*\)"/\1/'
}

version_key() {
  local base key
  base="$(basename "$1")"
  key="${base%%_*}"
  # A local copy is named <version>_0 by Chrome; a checkout or an unpacked download is not named
  # after its version, so read the manifest instead of comparing directory names.
  if ! printf '%s' "$key" | grep -qE '^[0-9]+(\.[0-9]+)*$'; then
    key="$(manifest_version "$1")"
    [ -n "$key" ] || key="$base"
  fi
  printf '%s' "$key"
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

DOWN_TMP=""
cleanup_tmp() { [ -n "${DOWN_TMP:-}" ] && rm -rf -- "$DOWN_TMP" || true; }
trap cleanup_tmp EXIT

# The CRX endpoint is the one the browser itself uses (the extension's manifest keeps that
# update_url). It serves the same package an install from the store would, so no account and no
# click are needed. The URL is a fixed https constant - nothing from the environment reaches its
# scheme or host - and the unpacked folder is validated before it is treated as a source.
download_extension() {
  local dest="$DOWN_TMP/unpacked" crx="$DOWN_TMP/extension.crx" prod url
  prod="${BROWSE_CRX_PRODVERSION:-125.0}"
  case "$prod" in '' | *[!0-9.]*) prod=125.0 ;; esac
  url="https://clients2.google.com/service/update2/crx"
  url="${url}?response=redirect&prodversion=${prod}&acceptformat=crx2,crx3&x=id%3D${EXT_ID}%26uc"
  case "$url" in https://clients2.google.com/*) ;; *) return 1 ;; esac
  command -v curl >/dev/null 2>&1 || return 1
  echo "[browse] no local extension copy; downloading it from the Chrome Web Store" >&2
  if ! curl -fsSL -m 120 --max-filesize 20000000 -o "$crx" "$url"; then
    echo "[browse] the download did not complete (offline or blocked)" >&2
    return 1
  fi
  if command -v python3 >/dev/null 2>&1; then
    # -I keeps the interpreter out of the working directory. A CRX is a protobuf header followed
    # by the zip, so extraction starts at the first local file header.
    if ! python3 -I - "$crx" "$dest" <<'PY'
import io, sys, zipfile
src, dest = sys.argv[1], sys.argv[2]
data = open(src, "rb").read()
start = data.find(b"PK\x03\x04")
if start < 0:
    sys.exit(1)
with zipfile.ZipFile(io.BytesIO(data[start:])) as archive:
    archive.extractall(dest)
PY
    then
      rm -rf -- "$dest"
      return 1
    fi
  elif command -v unzip >/dev/null 2>&1; then
    unzip -q -o "$crx" -d "$dest" 2>/dev/null || {
      rm -rf -- "$dest"
      return 1
    }
  else
    echo "[browse] neither python3 nor unzip is installed to unpack the download" >&2
    return 1
  fi
  # Chrome drops this on install; an unpacked copy is cleaner without it.
  rm -rf -- "$dest/_metadata"
  [ -f "$dest/manifest.json" ] && grep -qE '"name": *"OpenCode Browse"' "$dest/manifest.json"
}

consider_src "${BROWSE_EXTENSION_SRC:-}"
if [ "$UPDATE_EXT" -eq 0 ]; then
  if [ -d "$EXT_DIR" ]; then
    while IFS= read -r dir; do
      consider_src "$dir"
    done < <(find "$EXT_DIR" -mindepth 1 -maxdepth 1 -type d ! -name current 2>/dev/null | sort)
  fi

  # `browse extension` names the unpacked folder for a checkout or a dev install when it knows one.
  if EXT_HINT="$("$BROWSE" extension 2>/dev/null || true)"; then
    while IFS= read -r candidate; do
      consider_src "$candidate"
    done < <(printf '%s\n' "$EXT_HINT" | grep -oE '/[^[:space:]]+' || true)
  fi

  # A store install keeps its files at <profile>/Default/Extensions/<id>/<version>. The shared
  # browser's own profile is included: an install made in that window is what the fallback below
  # asks for, and finding it is what lets the next run finish instead of repeating the message.
  for profile_root in "$HOME/.config/google-chrome" "$HOME/.config/chromium" "$PROFILE"; do
    [ -d "$profile_root" ] || continue
    while IFS= read -r id_dir; do
      while IFS= read -r dir; do
        consider_src "$dir"
      done < <(find "$id_dir" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)
    done < <(find "$profile_root" -maxdepth 4 -type d -name "$EXT_ID" 2>/dev/null)
  done
fi

if [ -z "$BEST_SRC" ] && [ "$DOWNLOAD" -eq 1 ]; then
  DOWN_TMP="$(mktemp -d "${TMPDIR:-/tmp}/rakazo-browse-extension.XXXXXX")"
  if download_extension; then
    consider_src "$DOWN_TMP/unpacked"
  fi
fi

if [ -z "$BEST_SRC" ]; then
  echo "[browse] no extension copy found, and downloading it did not work." >&2
  echo "[browse] one manual step, then rerun this script:" >&2
  echo "[browse]   1. in the shared browser window, install \"OpenCode Browse\" from $STORE_URL" >&2
  echo "[browse]   2. bash scripts/native/browse-setup.sh" >&2
  echo "[browse] the install lands in $PROFILE, which this script reads on the rerun." >&2
  echo "[browse] offline instead: BROWSE_EXTENSION_SRC=/path/to/unpacked bash scripts/native/browse-setup.sh" >&2
  # Start the shared browser first: without a window there is nothing to install into, and this
  # also makes clear which browser the store page must be opened in.
  if bash "$ROOT/scripts/native/browser.sh"; then
    echo "[browse] the shared browser is open; install it there, then rerun." >&2
  else
    echo "[browse] could not start the shared browser; run scripts/native/browser.sh yourself." >&2
  fi
  exit 1
fi

EXT_STAGED="$EXT_DIR/${BEST_KEY}_0"
if [ ! -f "$EXT_STAGED/manifest.json" ]; then
  echo "[browse] staging the extension from $BEST_SRC"
  rm -rf -- "$EXT_STAGED"
  cp -a "$BEST_SRC" "$EXT_STAGED"
fi
if [ -n "${DOWN_TMP:-}" ]; then
  rm -rf -- "$DOWN_TMP"
  DOWN_TMP=""
fi
# Rebuild the link from scratch: renaming over a symlink that points at itself is how a loop is born.
rm -f "$EXT_DIR/current"
ln -s "$EXT_STAGED" "$EXT_DIR/current"
EXT_PATH="$(readlink -f "$EXT_DIR/current")"

if ! grep -qE '"name": *"OpenCode Browse"' "$EXT_PATH/manifest.json"; then
  echo "[browse] $EXT_PATH/manifest.json is not the OpenCode Browse extension" >&2
  exit 1
fi
EXT_VERSION="$(manifest_version "$EXT_PATH")"
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

# A copy from the store or its CRX carries the store key, so its id is EXT_ID; matching only that
# id keeps another extension in the profile from passing for browse. A checkout without the key
# gets an unpredictable id, so any extension target has to count.
expected_extension_id() {
  if grep -q '"key"' "$EXT_PATH/manifest.json" 2>/dev/null; then
    printf '%s' "$EXT_ID"
  fi
}

load_extension_targets() {
  local id
  id="$(expected_extension_id)"
  if [ -n "$id" ]; then
    curl -s -m 2 "http://127.0.0.1:${PORT}/json/list" 2>/dev/null |
      grep -o "chrome-extension://${id}" | sort -u || true
  else
    curl -s -m 2 "http://127.0.0.1:${PORT}/json/list" 2>/dev/null |
      grep -o 'chrome-extension://[a-p]\{32\}' | sort -u || true
  fi
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

launch_field() { sed -n "s/^$1=//p" "$LAUNCH_STATE" 2>/dev/null | head -1; }

# The --load-extension the running process was started with. browser.pid names the browser, and its
# command line is a record older launches left too, so this works before browser-launch.env existed.
process_extension_path() {
  local pid
  [ -f "$STATE/browser.pid" ] || return 1
  pid="$(cat "$STATE/browser.pid" 2>/dev/null || true)"
  [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] || return 1
  tr '\0' '\n' <"/proc/$pid/cmdline" 2>/dev/null | sed -n 's/^--load-extension=//p' | head -1
}

# Whether the copy the browser runs is the one staged now. The launch record is exact; a browser
# started outside browser.sh (or by an older copy of it) has none, so its own command line answers
# instead. A store-only launch has no --load-extension and is restarted once to load the staged one.
extension_current() {
  local path
  if [ -f "$LAUNCH_STATE" ]; then
    path="$(launch_field path)"
    [ -n "$path" ] && [ "$path" = "$EXT_PATH" ]
    return
  fi
  path="$(process_extension_path || true)"
  [ -n "$path" ] && [ "$(readlink -f "$path")" = "$EXT_PATH" ]
}

# A service worker sleeps, so ask the extension for a page before deciding it is missing.
wake_extension() {
  local tab
  tab="$(tab_id_of "$(open_tab "chrome-extension://${EXT_ID}/onboarding.html")")"
  for _ in $(seq 1 10); do
    extension_loaded && break
    sleep 0.5
  done
  close_tab "$tab"
}

if ! browser_up; then
  if ! bash "$ROOT/scripts/native/browser.sh"; then
    echo "[browse] the shared browser did not start, so the extension cannot be checked or paired." >&2
    echo "[browse] fix the browser first (its error is above), then rerun this script." >&2
    exit 1
  fi
fi

# A browser that was already running from before the extension was installed otherwise fails
# silently later, and one started on an older staged copy keeps it until it restarts.
if ! extension_loaded; then
  wake_extension
fi
if ! extension_loaded || ! extension_current; then
  if extension_loaded; then
    echo "[browse] the shared browser is not running the staged $EXT_VERSION; restarting it"
  else
    echo "[browse] the shared browser is without the extension; restarting it"
  fi
  bash "$ROOT/scripts/native/browser-stop.sh" >/dev/null 2>&1 || true
  if ! bash "$ROOT/scripts/native/browser.sh"; then
    echo "[browse] the shared browser did not restart; see its error above." >&2
    exit 1
  fi
  wake_extension
fi
if ! extension_loaded; then
  echo "[browse] the shared browser on 127.0.0.1:${PORT} did not load $EXT_PATH" >&2
  echo "[browse] branded Google Chrome may ignore --load-extension; install \"OpenCode Browse\"" >&2
  echo "[browse] from $STORE_URL in $PROFILE once, then rerun this script." >&2
  exit 1
fi
if ! extension_current; then
  echo "[browse] warning: could not confirm the shared browser runs $EXT_PATH." >&2
  echo "[browse] it reports an extension, so browse may still work; if a page uses an older copy," >&2
  echo "[browse] run browser-stop.sh and browser.sh, then rerun this script." >&2
fi

# --- pairing -----------------------------------------------------------------
paired() { "$BROWSE" status 2>/dev/null | grep -q '^Extension: connected'; }
relay_line() { "$BROWSE" status 2>/dev/null | sed -n 's/^Relay: *//p' | head -1; }

if [ "$PAIR" -eq 1 ] && ! paired; then
  echo "[browse] pairing the shared browser with the relay"
  : >"$PAIR_LOG"
  chmod 600 "$PAIR_LOG"
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
    RELAY="$(relay_line)"
    # Naming the missing half beats "no pairing code": a relay that never started and a code the
    # browser did not redeem look the same from here, and only one of them is a local fix.
    if [ -z "$RELAY" ] || printf '%s' "$RELAY" | grep -qiE 'not running|unavailable|error|failed'; then
      echo "[browse] the browse relay did not come up on 127.0.0.1:${RELAY_PORT}, and nothing can pair without it." >&2
      echo "[browse] start it, then rerun this script: $BROWSE relay restart" >&2
      echo "[browse] ($BROWSE status must print a Relay: line; pair log: $PAIR_LOG)" >&2
    else
      echo "[browse] browse pair printed no pairing code; the relay says: $RELAY (see $PAIR_LOG)" >&2
    fi
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
    echo "[browse] pairing was not confirmed ($(relay_line || true)). Enter $CODE under browse's" >&2
    echo "[browse] Options -> advanced (or click Pair with a code) in the shared browser, then rerun." >&2
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
PAIR_LIST="$("$BROWSE" pair --list 2>/dev/null || true)"
PAIRED_COUNT="$(printf '%s\n' "$PAIR_LIST" | grep -cE '^[^[:space:]]' || true)"
echo "[browse] paired browsers: ${PAIRED_COUNT:-0} ($BROWSE pair --list)"
# A second pairing is not harmless: with more than one browser paired, a bot's page work can land
# in the wrong one, and a person's own browser would then run it with their logins.
if [ "${PAIRED_COUNT:-0}" -gt 1 ]; then
  echo "[browse] warning: ${PAIRED_COUNT} browsers are paired; a bot's page work can land in the wrong one." >&2
  printf '%s\n' "$PAIR_LIST" | grep -E '^[^[:space:]]' | sed 's/^/           /' >&2
  echo "[browse] keep only the shared browser: $BROWSE pair --revoke <id>" >&2
fi
"$BROWSE" status 2>/dev/null | grep -E '^(Relay|Extension):' || true
