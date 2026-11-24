# The shared browser and browse

On a native (no Docker) install, one Chromium serves both the bot's computer panel and
[browse](https://github.com/anomalyco/browse), the MCP server that lets an agent drive the real
browser through an extension. A bot uses the same window, profile and logins either way.

```
Rakazo API/worker ──stdio──> browse mcp ──relay 127.0.0.1:19988──> browse extension
                                                                   │
                                              Chromium on 127.0.0.1:9222
                                              profile ~/.local/share/rakazo-native/browser-profile
```

## What runs where

- **The browser.** `scripts/native/browser.sh` starts one Chromium on the loopback DevTools port
  `RAKAZO_NATIVE_BROWSER_PORT` (9222 by default) with the profile from
  `RAKAZO_NATIVE_BROWSER_PROFILE` (`~/.local/share/rakazo-native/browser-profile`) and its cache in
  `/dev/shm/rakazo/chrome-cache`. `scripts/native/start.sh` and the desktop autostart entry both
  call it, and a lock makes the second caller wait instead of racing.
- **The extension.** `scripts/native/browse-setup.sh` copies the unpacked *OpenCode Browse*
  extension to `~/.local/share/rakazo-native/browse-extension/<version>` and points
  `.../browse-extension/current` at it. `browser.sh` resolves that link and passes the folder as
  `--load-extension` (with `--disable-extensions-except`), so every launch loads it. A host without
  that folder starts Chrome exactly as before.
- **The CLI and relay.** `browse` lives at `~/.local/bin/browse` when this host already has it;
  otherwise `browse-setup.sh` installs `@opencode/browse` from npm into
  `~/.local/share/rakazo-native/browse`, with no root. The relay is the browse service on
  `127.0.0.1:19988`; `browse status` reports both sides.
- **The state file.** `~/.local/share/rakazo-native/browse-status.json` (mode 600) records the CLI,
  the extension path and version, the relay port, and - while a pairing is waiting - the one-time
  code. It is the place to look when a pairing did not go through.

## Set it up

```bash
bash scripts/native/install-browser.sh     # Chrome for Testing, .env, extension, MCP policy
```

`install-browser.sh` runs `browse-setup.sh` and `browse-mcp-enable.sh` for you. To run just these
two, or to repair a host:

```bash
bash scripts/native/browse-setup.sh                  # stage extension, start browser, pair
bash scripts/native/browse-mcp-enable.sh --check     # write the MCP policy, prove its tools and browser
```

Both are safe to rerun. `browse-setup.sh` keeps a working CLI, keeps an existing pairing, and only
restarts the browser when the extension did not load; `--no-pair` and `--no-autostart` skip those
steps, and `--wait-seconds` bounds the pairing wait.

Then restart the API and worker so they read `.env`: `Ctrl+C` in the terminal running the stack,
then `scripts/native/start.sh`. Do not use `scripts/native/stop.sh` for this; it stops Postgres
too.

## The one step a person does

Local (stdio) MCP servers are off unless the deployment enables them, and only an admin can add
one. After the restart, sign in as an admin, then:

**Plugins → + (Add custom) → Manage MCP servers → Add server → STDIO**, with:

| Field    | Value                     |
| -------- | ------------------------- |
| Name     | `browse`                  |
| Command  | `/home/mahmoud/.local/bin/browse` |
| Arguments| `mcp`                     |
| Access   | **All bots** (default)    |

Bots cannot do this themselves: adding a stdio server is refused for them with "Bots can't add
local (stdio) MCP servers. Ask an admin to add it in Settings." If the STDIO tab is missing, either
the API has not been restarted since `.env` changed or the account is not an admin.

**All bots** is a deliberate choice, not a default to accept blindly: every bot given this server
can drive the shared Chromium with the logins saved in its profile.

### Prove the bot gets the tools

The server has 18 tools; a bot is offered only the eight page tools in `BROWSE_MCP_ALLOWED_TOOLS`
(`packages/adapters/src/browse/browse-mcp.ts:17-26`), because the connector filters a browse
catalog at discovery (`packages/adapters/src/mcp/mcp-connector.ts:571-574`). Two ways to see it:

- **In the panel.** Choose **Test connection** on the `browse` row. It launches `browse mcp` and
  lists its tools; a working server records the tool count (18) and shows no warning
  (`apps/api/src/integrations/mcp-servers.ts:234-241`,
  `apps/web/src/components/integrations/McpServerHealthLine.tsx:52`).
- **From a bot.** With the server assigned, ask "what is the state of browse?". The bot calls the
  `status` tool (`mcp__browse__status`) and the reply is JSON with `"connected":true`. The page
  tools are `mcp__browse__execute` plus the `session_*` and `tabs_cleanup` tools.

`bash scripts/native/browse-mcp-enable.sh --check` proves the server side of this without a login:
it fails unless all eight tools are in `tools/list` and the `status` tool returns `connected:true`.

## Check it

```bash
browse status                                   # Relay: ... / Extension: connected (0.1.5)
browse pair --list                              # paired browsers
bash scripts/native/browse-mcp-enable.sh --check  # 8/8 bot tools + a connected browser
pnpm exec tsx scripts/native/verify-browser.mts   # the panel's page browser still works
```

`--check` answers three questions: the server lists its tools (18), every tool a bot may call is
among them (8/8), and the bot's `status` tool returns `connected:true`. The last one is what the
settings panel cannot tell you; see below.

From a bot chat, ask "what is the state of browse?" - the bot calls the `status` tool and reports
`connected: true`. Right after a browser restart the extension needs a moment to reconnect; until
then `status` reports it as disconnected.

## When browse is not connected

`browse status` separates the two halves, and either can fail on its own:

```
Relay: http://127.0.0.1:19988 (0.0.16)
Extension: disconnected
```

In that state `browse mcp` still starts and lists its tools. The settings **Test connection** only
launches the server and lists tools (`packages/adapters/src/mcp/mcp-connector.ts:806-815`), so it
records the server as working and the row shows no warning. A tool call then has nothing to drive:
`execute` waits for a browser that never answers (about 30 s on relay 0.0.16) instead of failing
fast, while the bot's own `status` tool is the call that reports `"connected":false`.

The settings panel cannot show this state yet: its health line has only checking, installing,
working, not working and not checked, with no "disconnected"
(`apps/web/src/components/integrations/McpServerHealthLine.tsx:20-91`). Until it can, use the two
checks that do see it:

- `bash scripts/native/browse-mcp-enable.sh --check` exits 1 with "no browser is connected to the
  relay" instead of declaring the setup ready.
- A bot chat: "what is the state of browse?" returns `connected: false`.

Run `bash scripts/native/browse-setup.sh` to start and pair the shared browser, then rerun
`--check`. Starting the browser alone is enough when the pairing is intact; the extension
reconnects in a second or two.

## After an upgrade or an unpair

- **A new extension version.** Install or update *OpenCode Browse* in the shared browser, then run
  `browse-setup.sh` again. It compares the staged copy with the browser's own and stages the newer
  one, relinks `current`, and restarts the browser if it no longer loads the extension.
- **A new `browse` CLI** (`browse update`). Rerun `browse-setup.sh`, then `browse-mcp-enable.sh
  --check` and check `browse status`. If `--load-extension` is ever ignored, the extension simply
  never connects; the `Extension:` line is how you see it.
- **After unpairing** (`browse pair --revoke`, or wiping the profile). Rerun `browse-setup.sh`; it
  prints a code once, writes it to `browse-status.json`, opens the extension's onboarding page with
  the code, and closes that page when the relay confirms. If it cannot confirm, the code and the
  manual path are printed and the page stays open.
- **After moving the repository.** The autostart entry pins an absolute path to `browser.sh`;
  rerun `browse-setup.sh` to rewrite it.

## Limits

- **Chrome for Testing, not branded Chrome.** Google has removed `--load-extension` from branded
  builds before. This host runs Chrome for Testing; if `RAKAZO_NATIVE_CHROME_BIN` is pointed at a
  stable Chrome and the extension stops connecting, that is the reason, and `browse status` shows
  it. Installing the extension from the Chrome Web Store inside the profile is the fallback.
- **`--disable-extensions-except`** means an extension installed in this profile by hand will not
  load while the flag is present. The profile is the bots', not a person's; keep it that way.
- **Headless Chrome cannot sign in to Google.** Without a display the browser starts headless
  (`browser.sh`), the extension and pairing still work, but sign in through
  `scripts/native/browser-login.sh` on a session with a display.
- **Restarting this browser closes the tabs a bot or the panel is using.** Stop it with
  `scripts/native/browser-stop.sh`, never `kill`: Chrome writes cookies and logins at shutdown.

## Policies this setup touches

- `MCP_STDIO_ENABLED=true` is deployment-wide, not a browse setting: it allows stdio servers in
  general, and `MCP_STDIO_ALLOWED_COMMANDS` is what limits them. Keep that list short; here it is
  exactly one absolute path.
- Anyone who can edit `.env` can allowlist any binary, which is why `.env` is mode 600 and why
  adding a server stays an admin action; see
  [Tools and integrations](./self-host-integrations.md).
- The panel's own browser wiring is unchanged: `RAKAZO_NATIVE_BROWSER`, the profile and the page
  browser keep working, and `verify-browser.mts` is the regression check for them.
