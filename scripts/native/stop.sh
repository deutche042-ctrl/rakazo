#!/usr/bin/env bash
# Stops the native Postgres cluster. The API, worker and web app stop with
# Ctrl+C in the terminal running start.sh.
set -euo pipefail

STATE="$HOME/.local/share/rakazo-native"
PG_BIN="$STATE/tools/pg/node_modules/@embedded-postgres/linux-x64/native/bin"

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
