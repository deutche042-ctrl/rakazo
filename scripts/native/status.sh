#!/usr/bin/env bash
# Prints the native live link status as one JSON object:
#
#   {"state":"running|stopped|error|off","url":...,"since":...,"pid":...,"lastError":...}
#
# Read-only: it never writes or starts anything. A `running` state whose pid is gone (the stack
# was killed, or the machine rebooted) is reported as `error`, so a stale file cannot look live.
set -uo pipefail

STATE_DIR="${RAKAZO_NATIVE_STATE_DIR:-$HOME/.local/share/rakazo-native}"
STATUS="$STATE_DIR/status.json"

if [ ! -f "$STATUS" ]; then
  printf '{"state":"off","url":null,"since":null,"pid":null,"lastError":null}\n'
  exit 0
fi

# tunnel.sh writes values with no comma, so the first one ends a field.
read_field() {
  grep -o "\"$2\":[^,}]*" "$1" 2>/dev/null | head -1 | cut -d: -f2-
}

unquote() {
  local value="${1-}"
  value="${value#\"}"
  printf '%s' "${value%\"}"
}

state="$(unquote "$(read_field "$STATUS" state)")"
case "$state" in
  running | stopped | error | off) ;;
  *) state="off" ;;
esac
url="$(read_field "$STATUS" url)"
since="$(read_field "$STATUS" since)"
pid="$(read_field "$STATUS" pid)"
err="$(read_field "$STATUS" lastError)"
[ -n "$url" ] || url="null"
[ -n "$since" ] || since="null"
[ -n "$pid" ] || pid="null"
[ -n "$err" ] || err="null"

if [ "$state" = "running" ]; then
  pid_value="$(unquote "$pid")"
  alive=0
  if [ -n "$pid_value" ] && [ "$pid_value" != "null" ] && kill -0 "$pid_value" 2>/dev/null; then
    if [ ! -r "/proc/$pid_value/cmdline" ] ||
      tr '\0' ' ' <"/proc/$pid_value/cmdline" | grep -qi cloudflared; then
      alive=1
    fi
  fi
  if [ "$alive" != "1" ]; then
    state="error"
    url="null"
    pid="null"
    err='"The tunnel process is gone. Start it again with bash scripts/native/tunnel.sh."'
  fi
fi

printf '{"state":"%s","url":%s,"since":%s,"pid":%s,"lastError":%s}\n' \
  "$state" "$url" "$since" "$pid" "$err"
