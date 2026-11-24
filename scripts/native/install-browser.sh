#!/usr/bin/env bash
# Installs the shared browser userspace: agent-browser and Chrome for Testing.
# No root and no system packages.
set -euo pipefail

STATE="$HOME/.local/share/rakazo-native"
TOOLS="$STATE/tools/ab"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

mkdir -p "$TOOLS"
cd "$TOOLS"
[ -f package.json ] || npm init -y >/dev/null
npm i agent-browser@0.41.0 --no-audit --no-fund

echo "[browser] downloading Chrome for Testing"
./node_modules/.bin/agent-browser install

echo "[browser] writing .env paths"
cd "$ROOT"
node scripts/native/setup-env.mjs
