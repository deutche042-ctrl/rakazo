#!/usr/bin/env bash
# Installs Rakazo as a systemd user service that survives a crash and a logout.
#
#   bash scripts/native/install-service.sh
#
# Stop a manually started stack first (Ctrl+C in the terminal running start.sh), or the service
# will pick another port block because 3100 and 5173 are taken.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/rakazo-native.service"

mkdir -p "$UNIT_DIR"
cat >"$UNIT" <<EOF
[Unit]
Description=Rakazo native stack (no Docker)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=/bin/bash $ROOT/scripts/native/supervise.sh
Restart=always
RestartSec=5
KillMode=control-group
TimeoutStopSec=30
Environment=TMPDIR=/dev/shm/rakazo/tmp

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now rakazo-native.service
systemctl --user --no-pager --lines=0 status rakazo-native.service | head -5

cat <<'TXT'

Rakazo runs as a user service now.

  systemctl --user status rakazo-native     # what it is doing
  journalctl --user -u rakazo-native -f     # live logs
  systemctl --user restart rakazo-native    # restart the stack
  systemctl --user stop rakazo-native       # stop it

To keep it running after you log out (needed for 24/7), run once:

  sudo loginctl enable-linger "$USER"

Postgres and the browser stay up across a stack restart. A restart ends runs in progress.
TXT
