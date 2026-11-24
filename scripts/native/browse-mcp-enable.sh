#!/usr/bin/env bash
# Turns on local (stdio) MCP servers for this deployment and allowlists `browse`, so an admin can
# add browse's MCP server in the UI: Plugins -> + -> Manage MCP servers -> Add server -> STDIO.
#
#   bash scripts/native/browse-mcp-enable.sh
#   bash scripts/native/browse-mcp-enable.sh --check   # prove the bot's tools and a connected browser
#
# Only MCP_STDIO_ENABLED and MCP_STDIO_ALLOWED_COMMANDS change; .env stays 600 and no value from
# it is printed.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE="$HOME/.local/share/rakazo-native"
CLI_DIR="$STATE/browse"
ENV_FILE="$ROOT/.env"

CHECK=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    -h | --help)
      sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "[browse] unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

if [ ! -f "$ENV_FILE" ]; then
  echo "[browse] $ENV_FILE is missing; run: node scripts/native/setup-env.mjs" >&2
  exit 1
fi

BROWSE=""
for candidate in "${BROWSE_BIN:-}" "$HOME/.local/bin/browse" "$CLI_DIR/node_modules/.bin/browse"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    BROWSE="$candidate"
    break
  fi
done
if [ -z "$BROWSE" ]; then
  echo "[browse] no browse command; run: bash scripts/native/browse-setup.sh" >&2
  exit 1
fi

# The API and worker compare MCP_STDIO_ENABLED with the string "true" (apps/api/src/env.ts:375,
# packages/adapters/src/runs/assembly/run-runtime.ts:127), so 1 would leave stdio off.
read_key() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true; }

set_env() {
  local key="$1" value="$2" escaped
  # & and the | delimiter would change a sed replacement; both are escaped.
  escaped="$(printf '%s' "$value" | sed 's/[&|\\]/\\&/g')"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${escaped}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  fi
}

# The allowlist is an exact-match list on trimmed values (packages/adapters/src/mcp/mcp-transport.ts:330-333),
# so browse goes in by its absolute path, one comma-separated entry among whatever is already there.
ALLOWED="$(read_key MCP_STDIO_ALLOWED_COMMANDS)"
NEW_ALLOWED=""
FOUND=0
while IFS= read -r part; do
  part="$(printf '%s' "$part" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  [ -n "$part" ] || continue
  [ "$part" = "$BROWSE" ] && FOUND=1
  case ",${NEW_ALLOWED}," in
    *",${part},"*) ;;
    *) NEW_ALLOWED="${NEW_ALLOWED:+${NEW_ALLOWED},}${part}" ;;
  esac
done < <(printf '%s' "$ALLOWED" | tr ',' '\n')
if [ "$FOUND" -eq 0 ]; then
  NEW_ALLOWED="${NEW_ALLOWED:+${NEW_ALLOWED},}${BROWSE}"
fi

[ "$NEW_ALLOWED" = "$ALLOWED" ] || set_env MCP_STDIO_ALLOWED_COMMANDS "$NEW_ALLOWED"
set_env MCP_STDIO_ENABLED true
chmod 600 "$ENV_FILE"

# Re-read rather than trust what was written: a failed sed must not look like success.
ENABLED="$(read_key MCP_STDIO_ENABLED)"
ALLOWED_NOW="$(read_key MCP_STDIO_ALLOWED_COMMANDS)"
if [ "$ENABLED" != "true" ]; then
  echo "[browse] could not set MCP_STDIO_ENABLED=true in $ENV_FILE" >&2
  exit 1
fi
case ",${ALLOWED_NOW}," in
  *",${BROWSE},"*) ;;
  *)
    echo "[browse] could not add $BROWSE to MCP_STDIO_ALLOWED_COMMANDS" >&2
    exit 1
    ;;
esac
echo "[browse] .env: MCP_STDIO_ENABLED=true, MCP_STDIO_ALLOWED_COMMANDS includes $BROWSE"

if [ "$CHECK" -eq 1 ]; then
  # Same handshake Rakazo makes: initialize, the initialized notification, then one call. The
  # id is matched with its comma or brace so "id":2 cannot select "id":23.
  mcp_json() {
    local id="$1" method="$2" params="${3:-}" body
    if [ -n "$params" ]; then
      body="$(printf '{"jsonrpc":"2.0","id":%s,"method":"%s","params":%s}' "$id" "$method" "$params")"
    else
      body="$(printf '{"jsonrpc":"2.0","id":%s,"method":"%s"}' "$id" "$method")"
    fi
    {
      printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"rakazo","version":"0"}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
      printf '%s\n' "$body"
    } | timeout 30 "$BROWSE" mcp 2>/dev/null | grep -E "\"id\":$id[,}]" | tail -1 || true
  }

  RESPONSE="$(mcp_json 2 tools/list)"
  TOOLS="$(printf '%s' "$RESPONSE" | grep -o '"inputSchema"' | wc -l)"
  if ! printf '%s' "$RESPONSE" | grep -q '"tools"' || ! printf '%s' "$RESPONSE" | grep -q '"name":"execute"'; then
    echo "[browse] $BROWSE mcp answered nothing to tools/list" >&2
    echo "[browse] check that the relay runs: $BROWSE status" >&2
    exit 1
  fi

  # A bot only gets the page-action subset the connector keeps
  # (packages/adapters/src/browse/browse-mcp.ts:17-26, packages/adapters/src/mcp/mcp-connector.ts:571-574).
  # A tool the server stops exposing would leave that catalog silently, so read the list from the
  # connector's source and require each entry to be present. The fallback is only for a moved file.
  TOOL_SRC="$ROOT/packages/adapters/src/browse/browse-mcp.ts"
  BOT_TOOLS=""
  if [ -f "$TOOL_SRC" ]; then
    BOT_TOOLS="$(awk '/BROWSE_MCP_ALLOWED_TOOLS = \[/{found=1; next} found && /\] as const/{exit} found' "$TOOL_SRC" |
      grep -oE '"[a-z_]+"' | tr -d '"' | tr '\n' ' ')"
  fi
  if [ -z "${BOT_TOOLS// /}" ]; then
    BOT_TOOLS="execute status session_list session_new session_use session_reset session_delete tabs_cleanup"
  fi
  BOT_TOTAL="$(printf '%s' "$BOT_TOOLS" | wc -w)"
  BOT_PRESENT=0
  BOT_MISSING=""
  for tool in $BOT_TOOLS; do
    if printf '%s' "$RESPONSE" | grep -q "\"name\":\"$tool\""; then
      BOT_PRESENT=$((BOT_PRESENT + 1))
    else
      BOT_MISSING="${BOT_MISSING:+$BOT_MISSING, }$tool"
    fi
  done
  if [ -n "$BOT_MISSING" ]; then
    echo "[browse] the server does not expose tool(s) a bot is allowed to call: $BOT_MISSING" >&2
    echo "[browse] a missing tool disappears from every bot without an error; update $BROWSE" >&2
    exit 1
  fi

  # A server that starts and lists tools can still be unable to drive a browser: the relay is up
  # but no extension is paired. The settings "Test connection" only lists tools, so it records the
  # server as working (packages/adapters/src/mcp/mcp-connector.ts:806-815) while execute waits for a
  # browser that never answers. Ask the bot's own status tool and fail here instead of hanging later.
  CONNECTED=""
  for _ in $(seq 1 10); do
    STATUS_JSON="$(mcp_json 3 tools/call '{"name":"status","arguments":{}}')"
    [ -n "$STATUS_JSON" ] || continue
    CONNECTED=""
    if command -v node >/dev/null 2>&1; then
      CONNECTED="$(printf '%s' "$STATUS_JSON" | node -e '
        let s = "";
        process.stdin.on("data", (d) => (s += d)).on("end", () => {
          try {
            const line = s.trim().split("\n").filter(Boolean).pop();
            const message = JSON.parse(line);
            const body = JSON.parse(message.result.content[0].text);
            process.stdout.write(body.status.connected === true ? "1" : "0");
          } catch {
            process.stdout.write("0");
          }
        })' 2>/dev/null || true)"
    fi
    # Without node: status.connected is the first "connected" in the status text.
    if [ -z "${CONNECTED:-}" ]; then
      case "$STATUS_JSON" in
        *'"connected":true'*) CONNECTED=1 ;;
        *) CONNECTED=0 ;;
      esac
    fi
    [ "$CONNECTED" = "1" ] && break
    sleep 1
  done
  if [ "$CONNECTED" != "1" ]; then
    echo "[browse] the MCP server lists its tools, but no browser is connected to the relay" >&2
    echo "[browse] a bot's status tool reports connected:false and execute waits, not fails; a" >&2
    echo "[browse] settings Test connection can still record the server as working" >&2
    echo "[browse] start and pair the shared browser: bash scripts/native/browse-setup.sh" >&2
    exit 1
  fi

  echo "[browse] MCP server answers over stdio ($TOOLS tools)"
  echo "[browse] tools a bot can call: $BOT_PRESENT/$BOT_TOTAL (${BOT_TOOLS% })"
  echo "[browse] relay reports a connected browser (the bot's status tool returns connected:true)"
fi

cat <<EOF
[browse] the API and worker read this at startup, so restart them once:
           Ctrl+C in the terminal running setup, then scripts/native/start.sh
           (not scripts/native/stop.sh: it stops Postgres too)
[browse] then, as an admin in Settings -> Plugins -> + -> Manage MCP servers -> Add server:
           STDIO tab, name "browse", command "$BROWSE", arguments "mcp", Access "All bots"
[browse] --check proves the server lists every tool a bot may call and that a browser is connected
[browse] verify with: $BROWSE status   and   bash scripts/native/browse-mcp-enable.sh --check
[browse] from a bot that has the server: ask for the state of browse; its status tool must say connected:true
EOF
