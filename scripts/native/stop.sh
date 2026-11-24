#!/usr/bin/env bash
# Stops the native Postgres cluster and the live link. The API, worker and web app stop with
# Ctrl+C in the terminal running start.sh.
set -euo pipefail

STATE="$HOME/.local/share/rakazo-native"
PG_BIN="$STATE/tools/pg/node_modules/@embedded-postgres/linux-x64/native/bin"

# Close the live link too, so a stopped stack leaves no public URL pointing at nothing.
LIVE_STATE="${RAKAZO_NATIVE_STATE_DIR:-$STATE}"
LIVE_STATUS="$LIVE_STATE/status.json"
if [ -f "$LIVE_STATUS" ]; then
  TUNNEL_STATE="$(grep -o '"state":"[^"]*"' "$LIVE_STATUS" | head -1 | cut -d: -f2- || true)"
  TUNNEL_PID="$(grep -o '"pid":[^,}]*' "$LIVE_STATUS" | head -1 | cut -d: -f2- || true)"
  if [ "$TUNNEL_STATE" = '"running"' ] && [ -n "$TUNNEL_PID" ] && [ "$TUNNEL_PID" != "null" ]; then
    # The pid must still be the tunnel, or a recycled one would be killed.
    if [ ! -r "/proc/$TUNNEL_PID/cmdline" ] ||
      tr '\0' ' ' <"/proc/$TUNNEL_PID/cmdline" | grep -qi cloudflared; then
      kill -TERM "$TUNNEL_PID" 2>/dev/null || true
      echo "[native] live link stopped"
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
