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

if ! command -v tailscale >/dev/null 2>&1; then
  echo "[tailnet] installing Tailscale"
  sudo apt-get update
  sudo apt-get install -y tailscale
fi

echo "[tailnet] starting the Tailscale service"
sudo systemctl enable --now tailscaled

echo "[tailnet] signing in (open the URL it prints, then approve this machine)"
sudo tailscale up

if ! grep -q '^RAKAZO_DEV_TAILNET=' "$ROOT/.env" 2>/dev/null; then
  printf '\nRAKAZO_DEV_TAILNET=1\n' >> "$ROOT/.env"
  echo "[tailnet] added RAKAZO_DEV_TAILNET=1 to .env"
fi

HOST="$(tailscale status --json | python3 -c 'import sys,json; print((json.load(sys.stdin).get("Self") or {}).get("DNSName","").rstrip("."))')"
if [ -n "$HOST" ]; then
  echo
  echo "Tailnet host: $HOST"
  echo "After restarting the stack, use this in the phone app's 'Use a custom server':"
  echo "  https://$HOST:5173"
else
  echo "[tailnet] could not read the tailnet DNS name; check 'tailscale status'"
fi
echo
echo "Restart when ready: bash scripts/native/start.sh  (or: systemctl --user restart rakazo-native)"
