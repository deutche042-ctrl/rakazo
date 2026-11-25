#!/usr/bin/env bash
# Installs the shared browser userspace: agent-browser and Chrome for Testing.
# No root and no system packages.
set -euo pipefail
umask 077

STATE="$HOME/.local/share/rakazo-native"
TOOLS="$STATE/tools/ab"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXT_ID="${BROWSE_EXTENSION_ID:-mfnicocicmmlkpjnaffgihfjhdgjkdjg}"

read_env() {
  local name="$1"
  local from_file
  from_file="$(grep -E "^${name}=" "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)"
  printf '%s' "${!name:-$from_file}"
}

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
# browse-setup.sh downloads the extension when no copy exists; only an offline or blocked host
# falls through to the manual step below, and that step is said out loud instead of dropped.
echo "[browser] installing the browse extension"
BROWSE_READY=1
bash scripts/native/browse-setup.sh --wait-seconds 45 || BROWSE_READY=0

# Stdio MCP servers are off by default, so browse's server is unusable until this writes the policy.
# The policy is written either way: it is what lets an admin add the server after the manual step.
echo "[browser] enabling stdio MCP servers for browse"
if [ "$BROWSE_READY" -eq 1 ]; then
  bash scripts/native/browse-mcp-enable.sh --check ||
    echo "[browse] MCP policy written, but the server or browser check failed; rerun scripts/native/browse-mcp-enable.sh --check once browse is up" >&2
else
  bash scripts/native/browse-mcp-enable.sh ||
    echo "[browse] could not write the MCP policy; rerun scripts/native/browse-mcp-enable.sh" >&2
fi

if [ "$BROWSE_READY" -ne 1 ]; then
  PROFILE="$(read_env RAKAZO_NATIVE_BROWSER_PROFILE)"
  PROFILE="${PROFILE:-$STATE/browser-profile}"
  echo "[browser] browse setup did not finish; see the message above for the step it stopped at." >&2
  echo "[browser] The browser, .env and MCP policy are done. If the extension was the missing" >&2
  echo "[browser] piece, one manual step is left, then rerun this installer:" >&2
  echo "[browser]   1. in the shared browser window, install \"OpenCode Browse\" from" >&2
  echo "[browser]      https://chromewebstore.google.com/detail/${EXT_ID}" >&2
  echo "[browser]      (profile $PROFILE; scripts/native/browser.sh starts that window)" >&2
  echo "[browser]   2. bash scripts/native/browse-setup.sh   # adopts the copy and pairs" >&2
  exit 1
fi
