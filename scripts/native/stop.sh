#!/usr/bin/env bash
# Stops the native Postgres cluster. The API, worker and web app stop with
# Ctrl+C in the terminal running start.sh.
set -euo pipefail

STATE="$HOME/.local/share/rakazo-native"
PG_BIN="$STATE/tools/pg/node_modules/@embedded-postgres/linux-x64/native/bin"

if "$PG_BIN/pg_ctl" -D "$STATE/pgdata" status >/dev/null 2>&1; then
  "$PG_BIN/pg_ctl" -D "$STATE/pgdata" -m fast -w stop
  echo "[native] Postgres stopped"
else
  echo "[native] Postgres is not running"
fi
