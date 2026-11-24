#!/usr/bin/env bash
# Installs the shared browser userspace: agent-browser and Chrome for Testing.
# No root and no system packages.
set -euo pipefail
umask 077

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

# browse drives that same Chromium through its extension. The pairing is bounded here, because an
# unattended install must not sit for the default three minutes when the extension is missing.
echo "[browser] installing the browse extension"
bash scripts/native/browse-setup.sh --wait-seconds 45 ||
  echo "[browse] extension setup skipped; run scripts/native/browse-setup.sh yourself" >&2

# Stdio MCP servers are off by default, so browse's server is unusable until this writes the policy.
# The check also requires a connected browser; a failed pairing fails it after the policy is written.
echo "[browser] enabling stdio MCP servers for browse"
bash scripts/native/browse-mcp-enable.sh --check ||
  echo "[browse] MCP policy written, but the server or browser check failed; rerun scripts/native/browse-mcp-enable.sh --check once browse is up" >&2
