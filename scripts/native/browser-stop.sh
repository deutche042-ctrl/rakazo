#!/usr/bin/env bash
# Stops the shared Chromium cleanly so cookies and logins reach disk.
# SIGTERM first; Chrome flushes its profile, then exits.
set -euo pipefail

STATE="$HOME/.local/share/rakazo-native"
PIDFILE="$STATE/browser.pid"

if [ ! -f "$PIDFILE" ]; then
  echo "[browser] no pid file"
  exit 0
fi

PID="$(cat "$PIDFILE")"
if ! kill -0 "$PID" 2>/dev/null; then
  echo "[browser] not running"
  rm -f "$PIDFILE"
  exit 0
fi

echo "[browser] stopping $PID"
kill -TERM "$PID" 2>/dev/null || true
for _ in $(seq 1 30); do
  if ! kill -0 "$PID" 2>/dev/null; then
    rm -f "$PIDFILE"
    echo "[browser] stopped"
    exit 0
  fi
  sleep 1
done
echo "[browser] still running after 30s; leaving it for a later retry" >&2
exit 1
