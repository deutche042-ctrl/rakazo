#!/usr/bin/env bash
# Starts the native (no Docker) Rakazo stack on this host.
#   bash scripts/native/start.sh
# Press Ctrl+C to stop the API, worker and web app. Postgres keeps running;
# stop it with scripts/native/stop.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE="$HOME/.local/share/rakazo-native"
PG_BIN="$STATE/tools/pg/node_modules/@embedded-postgres/linux-x64/native/bin"
RAM_ROOT="/dev/shm/rakazo"

mkdir -p "$RAM_ROOT/data" "$RAM_ROOT/tmp" "$STATE/data"

if ! "$PG_BIN/pg_ctl" -D "$STATE/pgdata" status >/dev/null 2>&1; then
  echo "[native] starting Postgres on 127.0.0.1:5433"
  "$PG_BIN/pg_ctl" -D "$STATE/pgdata" -l "$STATE/pg.log" -w start
else
  echo "[native] Postgres already running"
fi

cd "$ROOT"
echo "[native] starting Rakazo (open http://127.0.0.1:5173)"
exec env TMPDIR="$RAM_ROOT/tmp" NODE_OPTIONS="--max-old-space-size=1536" pnpm dev
