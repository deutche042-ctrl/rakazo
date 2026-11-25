#!/usr/bin/env bash
# Prints the health of the native stack and where its RAM state lives.
set -uo pipefail

STATE="$HOME/.local/share/rakazo-native"
PG_BIN="$STATE/tools/pg/node_modules/@embedded-postgres/linux-x64/native/bin"

echo "== API =="
curl -sf -m 3 http://127.0.0.1:3100/internal/health || echo "API not answering"
echo
echo "== web =="
curl -s -o /dev/null -w "http %{http_code}\n" -m 3 http://localhost:5173/ || true
echo "== postgres =="
"$PG_BIN/pg_ctl" -D "$STATE/pgdata" status 2>/dev/null | head -1 || echo "not running"
echo "== browser =="
curl -sf -m 2 http://127.0.0.1:9222/json/version | head -c 90 || echo "not running"
echo "== /dev/shm =="
du -sh /dev/shm/rakazo/* 2>/dev/null || true
df -h /dev/shm | tail -1
echo "== memory =="
free -h | head -2
