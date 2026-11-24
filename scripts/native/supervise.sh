#!/usr/bin/env bash
# Keeps the native stack alive for real work: restarts it when the API stops answering, when the
# worker process disappears, or when the worker's memory passes a limit (upstream issue #6204: the
# worker's heap grows until V8 aborts, every 1-3 days).
#
#   bash scripts/native/supervise.sh
#
# Postgres and the shared browser keep running across a restart; only the API, worker and web are
# replaced. A restart ends runs that are in progress, so the memory limit is deliberately generous.
set -uo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE="$HOME/.local/share/rakazo-native"
LIMIT_MB="${RAKAZO_WORKER_RSS_MB:-1200}"
GRACE_SECONDS="${RAKAZO_SUPERVISE_GRACE:-90}"
CHECK_SECONDS="${RAKAZO_SUPERVISE_INTERVAL:-30}"

read_env() {
  local name="$1"
  local from_file
  from_file="$(grep -E "^${name}=" "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)"
  printf '%s' "${!name:-$from_file}"
}

API_PORT="$(read_env API_PORT)"; API_PORT="${API_PORT:-3100}"

log() {
  printf '%s %s\n' "$(date -Is)" "$*"
}

# Sums the resident memory of every process the worker owns: dev-watch, tsx watch, and the server.
worker_memory_mb() {
  local total=0
  local pid cwd rss
  for pid in $(pgrep -f "src/index.ts" 2>/dev/null); do
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null)" || continue
    case "$cwd" in
      */apps/worker)
        rss="$(awk '/^VmRSS:/{print $2}' "/proc/$pid/status" 2>/dev/null)"
        [ -n "$rss" ] && total=$((total + rss / 1024))
        ;;
    esac
  done
  printf '%s' "$total"
}

worker_present() {
  local pid cwd
  for pid in $(pgrep -f "src/index.ts" 2>/dev/null); do
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null)" || continue
    case "$cwd" in */apps/worker) return 0 ;; esac
  done
  return 1
}

stop_stack() {
  local pid="$1"
  log "stopping the stack (pid $pid)"
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 1
  done
  log "the stack did not stop in 20s; killing it"
  kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
}

log "supervising Rakazo (worker memory limit ${LIMIT_MB}MB, checks every ${CHECK_SECONDS}s)"
while true; do
  setsid bash "$ROOT/scripts/native/start.sh" &
  STACK=$!
  STARTED=$(date +%s)
  FAILS=0
  MISSING=0
  log "stack started (pid $STACK)"

  while kill -0 "$STACK" 2>/dev/null; do
    sleep "$CHECK_SECONDS"
    NOW=$(date +%s)
    [ $((NOW - STARTED)) -lt "$GRACE_SECONDS" ] && continue

    if curl -sf -m 3 "http://127.0.0.1:${API_PORT}/internal/health" >/dev/null 2>&1; then
      FAILS=0
    else
      FAILS=$((FAILS + 1))
      log "health check failed (${FAILS}/3)"
    fi

    if worker_present; then
      MISSING=0
    else
      MISSING=$((MISSING + 1))
      log "the worker process is gone (${MISSING}/2)"
    fi

    MEMORY="$(worker_memory_mb)"
    if [ -n "$MEMORY" ] && [ "$MEMORY" -gt "$LIMIT_MB" ]; then
      log "worker memory ${MEMORY}MB is over the ${LIMIT_MB}MB limit"
      stop_stack "$STACK"
      break
    fi

    if [ "$FAILS" -ge 3 ] || [ "$MISSING" -ge 2 ]; then
      stop_stack "$STACK"
      break
    fi
  done

  wait "$STACK" 2>/dev/null
  log "stack exited; restarting in 5s"
  sleep 5
done
