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
  call it, and a lock makes the second caller wait instead of racing. On a successful launch it
  records the extension copy it started (mode, path, version) in
  `~/.local/share/rakazo-native/browser-launch.env`, which is how a rerun tells whether the
  running copy is the staged one.
- **The extension.** `scripts/native/browse-setup.sh` adopts a copy already on the host - the
  shared profile, another Chrome or Chromium profile, or a folder `browse extension` names - and,
  when there is none, downloads the store package from the fixed HTTPS URL the extension's own
  manifest names (`https://clients2.google.com/service/update2/crx`), validates the unpacked
  folder, and stages it at `~/.local/share/rakazo-native/browse-extension/<version>`. It points
  `.../browse-extension/current` at the newest copy. `browser.sh` passes that folder as
  `--load-extension`; it adds `--disable-extensions-except` only for Chrome for Testing when the
  profile holds no store-installed copy, so an install from the Chrome Web Store keeps working as
  a fallback. A host without either still starts Chrome exactly as before.
- **The CLI and relay.** `browse` lives at `~/.local/bin/browse` when this host already has it;
  otherwise `browse-setup.sh` installs `@opencode/browse` from npm into
  `~/.local/share/rakazo-native/browse`, with no root. The relay is the browse service on
  `127.0.0.1:19988`; `browse status` reports both sides, and `browse pair` starts the relay when it
  is not running.
- **The state files.** `~/.local/share/rakazo-native/browse-status.json` (mode 600) records the
  CLI, the extension path and version, the relay port, and - while a pairing is waiting - the
  one-time code. It is the place to look when a pairing did not go through.
  `browser-launch.env` (mode 600) records what the running browser launched, which is what an
  upgrade check compares against.

## Set it up

```bash
bash scripts/native/install-browser.sh     # Chrome for Testing, .env, extension, MCP policy
```

`install-browser.sh` runs `browse-setup.sh` and `browse-mcp-enable.sh` for you, and downloads the
extension from the store when the host has no copy. If that download cannot happen (offline or
blocked), the installer stops with a non-zero status and prints the one manual extension step,
instead of leaving browse silently half-installed. To run just the two scripts, or to repair a
host:

```bash
bash scripts/native/browse-setup.sh                  # stage extension, start browser, pair
bash scripts/native/browse-mcp-enable.sh --check     # write the MCP policy, prove its tools and browser
```

Both are safe to rerun. `browse-setup.sh` keeps a working CLI, keeps an existing pairing, and
restarts the shared browser only when the extension did not load, when the copy the browser
launched is not the staged one (an upgrade), or when neither the launch record nor the running
process's command line shows the staged copy. `--no-pair`, `--no-autostart` and `--no-download` skip
those steps, `--update-extension` fetches the current store package even when a copy is already
staged, and `--wait-seconds` bounds the pairing wait. For an offline host, point it at an unpacked
copy instead of downloading:

```bash
BROWSE_EXTENSION_SRC=/path/to/unpacked bash scripts/native/browse-setup.sh
```

Then restart the API and worker so they read `.env`: `Ctrl+C` in the terminal running the stack,
then `scripts/native/start.sh`. Do not use `scripts/native/stop.sh` for this; it stops Postgres
too.

## The one step a person does

Local (stdio) MCP servers are off unless the deployment enables them, and only an admin can add
one. After the restart, sign in as an admin, then:

**Plugins → + (Add custom) → Manage MCP servers → Add server → STDIO**, with:

| Field     | Value                                                                   |
| --------- | ----------------------------------------------------------------------- |
| Name      | `browse` - exactly this, lowercase                                      |
| Command   | the absolute path `browse-mcp-enable.sh` prints, e.g. `~/.local/bin/browse` |
| Arguments | `mcp`                                                                   |
| Access    | **All bots** (default)                                                  |

`bash scripts/native/browse-mcp-enable.sh` prints the exact `command "..."` line to copy. Use that
string verbatim: it is the same path the script added to `MCP_STDIO_ALLOWED_COMMANDS`, and any
other string is refused with "This stdio command isn't allowed here".

The name is load-bearing. `isBrowseMcpServer` recognises the row by its command
(`packages/adapters/src/browse/browse-mcp.ts:99-109`), so a row named something else is still
filtered to browse's page tools, but its tools become `mcp__<name>__*`. The bot's instructions
name `mcp__browse__execute` and fall back to `browser_navigate` / `browser_snapshot` /
`browser_act` when that name is absent
(`packages/adapters/src/browse/browse-instructions.ts:32-39,47-63`), and this server offers none
of those. A second server can also push the derived slug to `browse-2`. Add it once, named
`browse`; if a row already exists under another name, remove it first.

Bots cannot do this themselves: adding a stdio server is refused for them with "Bots can't add
local (stdio) MCP servers. Ask an admin to add it in Settings." If the STDIO tab is missing, either
the API has not been restarted since `.env` changed or the account is not an admin.

**All bots** is a deliberate choice, not a default to accept blindly: every bot given this server
can drive the shared Chromium with the logins saved in its profile.

### If the extension could not be downloaded

On a host with no local copy and no route to the Chrome Web Store, `install-browser.sh` and
`browse-setup.sh` both stop and say so. There is then one extra manual step, in this order:

1. Make sure the shared browser window is open; `scripts/native/browser.sh` starts it if needed.
2. In **that** window, install *OpenCode Browse* from
   `https://chromewebstore.google.com/detail/mfnicocicmmlkpjnaffgihfjhdgjkdjg`.
3. Rerun `bash scripts/native/browse-setup.sh`. It reads the install from the shared profile
   (`~/.local/share/rakazo-native/browser-profile` unless `RAKAZO_NATIVE_BROWSER_PROFILE` says
   otherwise), stages it, and pairs.

The store page must be opened in the shared browser, not on another computer: that is the window
the bot uses, and the script reads its profile on the rerun.

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
browse pair --list                              # paired browsers: exactly one
bash scripts/native/browse-mcp-enable.sh --check  # 8/8 bot tools + a connected browser
pnpm exec tsx scripts/native/verify-browser.mts   # the panel's page browser still works
```

`--check` answers three questions: the server lists its tools (18), every tool a bot may call is
among them (8/8), and the bot's `status` tool returns `connected:true`. The last one is what the
settings panel cannot tell you; see below.

From a bot chat, ask "what is the state of browse?" - the bot calls the `status` tool and reports
`connected: true`. Right after a browser restart the extension needs a moment to reconnect; until
then `status` reports it as disconnected.

### Pair only the shared browser

`browse pair --list` must show one row. A second pairing is not cosmetic: with more than one
browser paired, a bot's page work can land in the wrong one, so a personal browser on the same
host can run it with that person's logins. If the list has more than one entry, keep the shared one
and revoke the rest:

```bash
browse pair --list
browse pair --revoke <id-or-name>
```

`browse-setup.sh` prints a warning with the same instruction when it finds more than one pairing.

## When browse is not connected

`browse status` separates the two halves, and either can fail on its own:

```
Relay: http://127.0.0.1:19988 (0.0.16)
Extension: disconnected
```

If the `Relay:` line is missing, the relay itself is not running: `browse relay restart` starts
it, and rerunning `browse-setup.sh` also pairs the browser. When `pair` prints no code,
`browse-setup.sh` now names which of the two halves is missing instead of only pointing at its log.

In the disconnected state `browse mcp` still starts and lists its tools. The settings **Test
connection** only launches the server and lists tools
(`packages/adapters/src/mcp/mcp-connector.ts:806-815`), so it records the server as working and
the row shows no warning. A tool call then has nothing to drive: `execute` waits for a browser that
never answers (about 30 s on relay 0.0.16) instead of failing fast, while the bot's own `status`
tool is the call that reports `"connected":false`.

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

## After an upgrade, a Google sign-in, or an unpair

- **A new extension version.** Run `browse-setup.sh` again. It adopts the newest copy on the host
  (including one Chrome updated in the shared profile), stages it, relinks `current`, and restarts
  the browser when the copy it launched (from `browser-launch.env`) is not the staged one. A host
  that installed the extension through this script has no store copy that updates itself, so use
  `browse-setup.sh --update-extension` to fetch the current store package. Restarting closes the
  tabs a bot or the panel is using.
- **A new `browse` CLI** (`browse update`). Rerun `browse-setup.sh`, then `browse-mcp-enable.sh
  --check` and check `browse status`. If `--load-extension` is ever ignored, the extension simply
  never connects; the `Extension:` line is how you see it.
- **After a Google sign-in.** `scripts/native/browser-login.sh` restarts the shared browser on the
  real Google Chrome it signed in with, and branded Chrome may ignore `--load-extension`. Run
  `bash scripts/native/browse-setup.sh` afterwards: it re-checks the extension, and if it cannot
  load it, says so. The durable fix is one store install in the shared profile (see *Limits*);
  after the next launch, `browser.sh` keeps that copy loadable. Nothing can run that check for you
  inside `browser-login.sh`, so make the rerun part of the sign-in procedure.
- **After unpairing** (`browse pair --revoke`, or wiping the profile). Rerun `browse-setup.sh`; it
  prints a code once, writes it to `browse-status.json`, opens the extension's onboarding page with
  the code, and closes that page when the relay confirms. If it cannot confirm, the code and the
  manual path are printed and the page stays open.
- **After moving the repository.** The autostart entry pins an absolute path to `browser.sh`;
  rerun `browse-setup.sh` to rewrite it.

## Limits

- **Chrome for Testing, not branded Chrome.** Google has removed `--load-extension` from branded
  builds before. `install-browser.sh` downloads Chrome for Testing, which honours it. Branded
  Google Chrome does not always: `browser-login.sh` restarts the shared browser with it so the
  Google session stays, and that can lose the extension. The fallback is installing *OpenCode
  Browse* from the Chrome Web Store once inside the shared profile; under branded Chrome,
  `browser.sh` does not restrict extensions, so that copy loads without waiting for another
  launch, and the next launch drops `--disable-extensions-except` as well because the copy exists.
  `browse status` shows whether it did.
- **`--disable-extensions-except`** is passed only for Chrome for Testing with no store-installed
  copy in the profile. Once any such copy exists, or the binary is branded Chrome, the next launch
  stops restricting extensions, so keep the profile free of anything but *OpenCode Browse*: a bot's
  page work shares it.
- **browse's `execute` is outside the purchase approval.** `execute` runs Playwright code, so the
  gate that guards `browser_act` cannot inspect it. The instructions ask a bot to finish a payment
  with `browser_act` (`packages/adapters/src/browse/browse-instructions.ts:56`), but nothing
  enforces that; assignment is the control. Give this server only to bots you would let click
  through a checkout with the profile's saved cards.
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
- The extension package is fetched from Google's own update service at the URL its manifest names.
  It is validated as *OpenCode Browse* after unpacking, and `--no-download` or
  `BROWSE_EXTENSION_SRC` covers a host that must not fetch it.
- The panel's own browser wiring is unchanged: `RAKAZO_NATIVE_BROWSER`, the profile and the page
  browser keep working, and `verify-browser.mts` is the regression check for them.
