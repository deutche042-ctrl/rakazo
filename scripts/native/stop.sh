#!/usr/bin/env bash
# Stops the native Postgres cluster and the live link. The API, worker and web app stop with
# Ctrl+C in the terminal running start.sh.
set -euo pipefail

STATE="$HOME/.local/share/rakazo-native"
PG_BIN="$STATE/tools/pg/node_modules/@embedded-postgres/linux-x64/native/bin"

# Close the live link too, so a stopped stack leaves no public URL pointing at nothing.
LIVE_STATE="${RAKAZO_NATIVE_STATE_DIR:-$STATE}"
LIVE_STATUS="$LIVE_STATE/status.json"

# The same shape tunnel.sh writes, so the API and status.sh read a plain `stopped`. Needed when
# the tunnel manager is already dead: nobody else would clear `running`, and a dead pid would be
# reported as `error` rather than a stop the person asked for. It only overwrites the state that
# named the pid it stopped, so a tunnel started meanwhile is not reported as stopped.
write_stopped_status() {
  local stopped_pid="$1"
  local current
  current="$(grep -o '"pid":[^,}]*' "$LIVE_STATUS" 2>/dev/null | head -1 | cut -d: -f2- || true)"
  [ "$current" = "$stopped_pid" ] || return 0
  local tmp="$LIVE_STATUS.tmp.$$"
  printf '{"state":"stopped","url":null,"since":null,"pid":null,"lastError":null}\n' >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$LIVE_STATUS"
}

if [ -f "$LIVE_STATUS" ]; then
  TUNNEL_STATE="$(grep -o '"state":"[^"]*"' "$LIVE_STATUS" | head -1 | cut -d: -f2- || true)"
  TUNNEL_PID="$(grep -o '"pid":[^,}]*' "$LIVE_STATUS" | head -1 | cut -d: -f2- || true)"
  if [ "$TUNNEL_STATE" = '"running"' ] && [ -n "$TUNNEL_PID" ] && [ "$TUNNEL_PID" != "null" ]; then
    # The pid must still be the tunnel, or a recycled one would be killed.
    if [ ! -r "/proc/$TUNNEL_PID/cmdline" ] ||
      tr '\0' ' ' <"/proc/$TUNNEL_PID/cmdline" | grep -qi cloudflared; then
      kill -TERM "$TUNNEL_PID" 2>/dev/null || true
      # Give a live manager time to run its trap and write `stopped` itself; a killed one cannot.
      for _ in $(seq 1 25); do
        kill -0 "$TUNNEL_PID" 2>/dev/null || break
        sleep 0.2
      done
      kill -KILL "$TUNNEL_PID" 2>/dev/null || true
      if kill -0 "$TUNNEL_PID" 2>/dev/null; then
        echo "[native] the live link did not stop (pid $TUNNEL_PID)" >&2
      else
        write_stopped_status "$TUNNEL_PID"
        echo "[native] live link stopped"
      fi
    fi
  fi
fi

# Chrome flushes cookies and logins on SIGTERM; stopping it first keeps them.
if [ -x "$(dirname "${BASH_SOURCE[0]}")/browser-stop.sh" ]; then
  bash "$(dirname "${BASH_SOURCE[0]}")/browser-stop.sh" || true
fi

if "$PG_BIN/pg_ctl" -D "$STATE/pgdata" status >/dev/null 2>&1; then
  "$PG_BIN/pg_ctl" -D "$STATE/pgdata" -m fast -w stop
  echo "[native] Postgres stopped"
else
  echo "[native] Postgres is not running"
fi
