#!/usr/bin/env bash
# One-time: let your own devices reach this Rakazo server over Tailscale, so the phone works
# outside the house without opening a port on the router.
#
#   bash scripts/native/setup-tailnet.sh
#
# Installs Tailscale (asks for your sudo password), signs this machine into your tailnet, and
# turns on RAKAZO_DEV_TAILNET in .env. The stack is NOT restarted; do that when you are ready so
# an open test is not interrupted.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# The printed link has to name the port `tailscale serve` will share, which is WEB_PORT from the
# shell or .env (or dev.mjs's chosen block). A fixed 5173 would be wrong on a second checkout.
read_web_port() {
  local from_env=""
  if [ -f "$ROOT/.env" ]; then
    from_env="$(grep -E '^WEB_PORT=' "$ROOT/.env" | head -1 | cut -d= -f2- || true)"
  fi
  local port="${WEB_PORT:-${from_env:-5173}}"
  case "$port" in
    '' | *[!0-9]*) port=5173 ;;
  esac
  printf '%s' "$port"
}
WEB_PORT_VALUE="$(read_web_port)"

if ! command -v tailscale >/dev/null 2>&1; then
  echo "[tailnet] installing Tailscale"
  sudo apt-get update
  sudo apt-get install -y tailscale
fi

echo "[tailnet] starting the Tailscale service"
sudo systemctl enable --now tailscaled

echo "[tailnet] signing in (open the URL it prints, then approve this machine)"
sudo tailscale up

# Read the name before writing the flag: a sign-in that did not finish must not leave
# RAKAZO_DEV_TAILNET=1 behind, or every later start fails on a tailnet that is not there.
HOST=""
if command -v python3 >/dev/null 2>&1; then
  # sudo: `tailscale up` above ran as root, so the socket may only answer root until an operator
  # is set.
  HOST="$(sudo tailscale status --json 2>/dev/null |
    python3 -c 'import sys,json; print((json.load(sys.stdin).get("Self") or {}).get("DNSName","").rstrip("."))' ||
    true)"
fi

if [ -z "$HOST" ]; then
  echo "[tailnet] could not read the tailnet DNS name; run 'tailscale status' and try again." >&2
  echo "[tailnet] RAKAZO_DEV_TAILNET was not set, so the stack keeps starting as before." >&2
  exit 1
fi

if ! grep -q '^RAKAZO_DEV_TAILNET=' "$ROOT/.env" 2>/dev/null; then
  printf '\nRAKAZO_DEV_TAILNET=1\n' >> "$ROOT/.env"
  echo "[tailnet] added RAKAZO_DEV_TAILNET=1 to .env"
fi

echo
echo "Tailnet host: $HOST"
echo "After restarting the stack, use this in the phone app's 'Use a custom server':"
echo "  https://$HOST:$WEB_PORT_VALUE"
echo
echo "Restart when ready: bash scripts/native/start.sh  (or: systemctl --user restart rakazo-native)"
