#!/usr/bin/env bash
# Runs a public live link for the native stack through a Cloudflare quick tunnel.
#
#   bash scripts/native/tunnel.sh
#
# The quick tunnel needs no Cloudflare account and gives a new https://<words>.trycloudflare.com
# URL on every run. It points at the web app on this machine (WEB_PORT from .env, else 5173), so
# start the stack first. State lives in ~/.local/share/rakazo-native, mode 600: live-link.json,
# status.json and tunnel.log. SIGTERM (what scripts/native/stop.sh sends) closes the tunnel the
# same way Ctrl+C does.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE="${RAKAZO_NATIVE_STATE_DIR:-$HOME/.local/share/rakazo-native}"
STATUS="$STATE/status.json"
LINK="$STATE/live-link.json"
LOG="$STATE/tunnel.log"

mkdir -p "$STATE"
chmod 700 "$STATE" 2>/dev/null || true

log() {
  printf '%s %s\n' "$(date -Is)" "$*" >>"$LOG"
}

# Neither key nor value may carry a quote, a backslash or a newline: status.sh reads these files
# with a line-oriented parser, and the values come from a log we do not control.
clean() {
  printf '%s' "${1-}" | tr -d '\000-\037"\\' | cut -c1-400
}

json_str() {
  if [ -z "${1-}" ]; then printf 'null'; else printf '"%s"' "$(clean "$1")"; fi
}

write_status() {
  local state="$1" url="${2-}" since="${3-}" pid="${4-}" err="${5-}"
  local pid_json="null" tmp="$STATUS.tmp.$$"
  case "$pid" in '' | *[!0-9]*) ;; *) pid_json="$pid" ;; esac
  printf '{"state":"%s","url":%s,"since":%s,"pid":%s,"lastError":%s}\n' \
    "$state" "$(json_str "$url")" "$(json_str "$since")" "$pid_json" "$(json_str "$err")" >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$STATUS"
}

write_link() {
  local tmp="$LINK.tmp.$$"
  printf '{"url":%s,"port":%s,"since":%s,"pid":%s}\n' \
    "$(json_str "$1")" "$PORT" "$(json_str "$2")" "$3" >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$LINK"
}

# Values written above hold no comma or brace, so the first one ends a field.
read_field() {
  grep -o "\"$2\":[^,}]*" "$1" 2>/dev/null | head -1 | cut -d: -f2-
}

unquote() {
  local value="${1-}"
  value="${value#\"}"
  printf '%s' "${value%\"}"
}

# A live pid is only ours when its command line still says cloudflared (where /proc exists).
is_tunnel_pid() {
  kill -0 "$1" 2>/dev/null || return 1
  [ -r "/proc/$1/cmdline" ] || return 0
  tr '\0' ' ' <"/proc/$1/cmdline" | grep -qi cloudflared
}

read_port() {
  local from_env=""
  if [ -f "$ROOT/.env" ]; then
    from_env="$(grep -E '^WEB_PORT=' "$ROOT/.env" | head -1 | cut -d= -f2- || true)"
  fi
  local port="${WEB_PORT:-${from_env:-5173}}"
  case "$port" in '' | *[!0-9]*) port=5173 ;; esac
  printf '%s' "$port"
}

PORT="$(read_port)"

if [ -f "$STATUS" ]; then
  PREV_STATE="$(unquote "$(read_field "$STATUS" state)")"
  PREV_PID="$(unquote "$(read_field "$STATUS" pid)")"
  if [ "$PREV_STATE" = "running" ] && [ -n "$PREV_PID" ] && [ "$PREV_PID" != "null" ] &&
    is_tunnel_pid "$PREV_PID"; then
    echo "[tunnel] already running (pid $PREV_PID) at $(unquote "$(read_field "$STATUS" url)")" >&2
    echo "[tunnel] stop it first: bash scripts/native/stop.sh" >&2
    exit 1
  fi
fi

CLOUDFLARED=""
if command -v cloudflared >/dev/null 2>&1; then
  CLOUDFLARED="$(command -v cloudflared)"
elif [ -x "$HOME/.local/bin/cloudflared" ]; then
  CLOUDFLARED="$HOME/.local/bin/cloudflared"
fi

if [ -z "$CLOUDFLARED" ]; then
  write_status error "" "" "" "cloudflared is not installed"
  cat >&2 <<'MSG'
[tunnel] cloudflared is not installed, so no live link can start.
[tunnel] Install it once, then run this script again:
[tunnel]   mkdir -p "$HOME/.local/bin"
[tunnel]   curl -fsSL -o "$HOME/.local/bin/cloudflared" \
[tunnel]     https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
[tunnel]   chmod +x "$HOME/.local/bin/cloudflared"
[tunnel]   echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
[tunnel] Debian and Ubuntu can also use Cloudflare's package repository.
MSG
  exit 1
fi

if command -v curl >/dev/null 2>&1; then
  if ! curl -sf -m 2 -o /dev/null "http://127.0.0.1:$PORT/"; then
    echo "[tunnel] warning: nothing answers on http://127.0.0.1:$PORT yet;" \
      "the link will fail until the stack is up" >&2
  fi
fi

: >>"$LOG"
chmod 600 "$LOG"
printf '\n[tunnel] %s starting a quick tunnel to http://127.0.0.1:%s\n' "$(date -Is)" "$PORT" |
  tee -a "$LOG" >&2
BEFORE_SIZE="$(wc -c <"$LOG" | tr -d ' ')"

TUNNEL_PID=""
FINAL_STATE="stopped"
FINAL_ERROR=""

cleanup() {
  trap - EXIT INT TERM
  if [ -n "$TUNNEL_PID" ] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
    kill -TERM "$TUNNEL_PID" 2>/dev/null || true
    for _ in $(seq 1 25); do
      kill -0 "$TUNNEL_PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -KILL "$TUNNEL_PID" 2>/dev/null || true
  fi
  if [ -n "$TUNNEL_PID" ]; then wait "$TUNNEL_PID" 2>/dev/null || true; fi
  write_status "$FINAL_STATE" "" "" "" "$FINAL_ERROR"
  log "closed ($FINAL_STATE${FINAL_ERROR:+: $FINAL_ERROR})"
  echo "[tunnel] closed"
}
trap cleanup EXIT
trap 'FINAL_STATE=stopped; exit 130' INT
trap 'FINAL_STATE=stopped; exit 143' TERM

"$CLOUDFLARED" tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" >>"$LOG" 2>&1 &
TUNNEL_PID=$!

URL=""
DEADLINE=$((SECONDS + 30))
while [ "$SECONDS" -lt "$DEADLINE" ]; do
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then break; fi
  URL="$(tail -c "+$((BEFORE_SIZE + 1))" "$LOG" |
    grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)"
  [ -n "$URL" ] && break
  sleep 0.5
done

if [ -z "$URL" ]; then
  LAST_LINE="$(tail -n 1 "$LOG" | tr -d '\000-\037"\\' | cut -c1-300)"
  FINAL_STATE="error"
  FINAL_ERROR="cloudflared reported no tunnel URL: ${LAST_LINE:-it exited}"
  echo "[tunnel] $FINAL_ERROR" >&2
  echo "[tunnel] see $LOG" >&2
  exit 1
fi

SINCE="$(date -Is)"
write_status running "$URL" "$SINCE" "$TUNNEL_PID" ""
write_link "$URL" "$SINCE" "$TUNNEL_PID"
log "live link $URL (pid $TUNNEL_PID, port $PORT)"
cat >&2 <<MSG

[tunnel] Live link: $URL
[tunnel] Open it from anywhere; it changes on every run and needs no account.
[tunnel] On this machine: http://127.0.0.1:$PORT
[tunnel] Ctrl+C, or bash scripts/native/stop.sh, closes it.

MSG

set +e
wait "$TUNNEL_PID"
EXIT_CODE=$?
set -e
# 143/130 are SIGTERM/SIGINT: scripts/native/stop.sh and the API stop the tunnel this way, so an
# asked-for termination is a stop, not a failure.
case "$EXIT_CODE" in
  0 | 130 | 143) FINAL_STATE="stopped" ;;
  *)
    FINAL_STATE="error"
    FINAL_ERROR="cloudflared exited with code $EXIT_CODE"
    ;;
esac
