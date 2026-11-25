#!/usr/bin/env node
// Writes .env for a native (no Docker) Rakazo install on this host.
//
//   node scripts/native/setup-env.mjs
//
// Secrets live in ~/.local/share/rakazo-native/{owner.pw,app.pw} (600) and are
// copied into .env without ever being printed. Rerunning keeps existing secrets, origins and
// ports, so a LAN or tailnet address the person set is not replaced with localhost.
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const state = path.join(homedir(), ".local/share/rakazo-native");
const envFile = path.join(root, ".env");
const example = path.join(root, ".env.example");
// Durable state (workspace, bot files) must survive a reboot, so it lives on disk.
// /dev/shm holds only cache, temp files and scratch data.
const dataDir = path.join(state, "data");

// The state tree holds credentials, cookies and bot files; no other local user may read it.
mkdirSync(state, { recursive: true, mode: 0o700 });
chmodSync(state, 0o700);
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
chmodSync(dataDir, 0o700);

const hex = (bytes) => randomBytes(bytes).toString("hex");
const read = (file) => readFileSync(file, "utf8").trim();

function requireFile(file) {
  if (!existsSync(file)) {
    throw new Error(`Missing ${file}. Start the local Postgres cluster first.`);
  }
  return read(file);
}

const ownerPassword = requireFile(path.join(state, "owner.pw"));
const appPassword = requireFile(path.join(state, "app.pw"));

if (!existsSync(envFile)) copyFileSync(example, envFile);
let env = readFileSync(envFile, "utf8");

/** Sets KEY=value, replacing the first line for KEY or appending one. */
function set(key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  env = pattern.test(env) ? env.replace(pattern, line) : `${env.replace(/\n?$/, "\n")}${line}\n`;
}

/** Keeps an existing non-placeholder value so reruns never rotate a live secret. */
function setUnlessReal(key, generate) {
  const match = env.match(new RegExp(`^${key}=(.*)$`, "m"));
  const current = match?.[1]?.trim() ?? "";
  if (current && !/^replace-with/.test(current)) return;
  set(key, generate());
}

/** Writes a default only when the key is absent or still the template's placeholder. */
function setDefault(key, value) {
  setUnlessReal(key, () => value);
}

set("NODE_ENV", "development");
set("POSTGRES_USER", "rakazo");
set("POSTGRES_DB", "rakazo");
set("POSTGRES_PASSWORD", ownerPassword);
set("POSTGRES_APP_PASSWORD", appPassword);
set("DATABASE_MIGRATION_URL", `postgres://rakazo:${ownerPassword}@127.0.0.1:5433/rakazo`);
set("DATABASE_URL", `postgres://rakazo_app:${appPassword}@127.0.0.1:5433/rakazo`);
setUnlessReal("BETTER_AUTH_SECRET", () => hex(32));
setUnlessReal("ENCRYPTION_KEY", () => hex(32));
setUnlessReal("SCREEN_PROXY_SECRET", () => hex(32));
setUnlessReal("SANDBOX_SUPERVISOR_TOKEN", () => hex(32));
set("SANDBOX_PROVIDER", "desktop");
// The desktop app and the probes are pinned to these ports; naming them turns off port
// selection in scripts/dev.mjs so the sign-in origin survives relaunches. A value the person
// already chose (a LAN or tailnet address, another port) is kept, as the header promises.
setDefault("WEB_PORT", "5173");
setDefault("API_PORT", "3100");
// WebAuthn binds passkeys to `localhost`; the loopback IP would silently disable them.
setDefault("BETTER_AUTH_URL", "http://localhost:5173");
setDefault("WEB_ORIGIN", "http://localhost:5173");
setDefault("API_URL", "http://localhost:3100");
set("DATA_DIR", dataDir);
// A person who turned signups off or removed the emulator (for a tailnet run) keeps that choice.
setDefault("EMAIL_EMULATOR", "true");
setDefault("SIGNUPS_ENABLED", "true");

// The one shared browser. Paths are discovered, so a new Chrome download needs nothing here.
function newestChrome() {
  const base = path.join(homedir(), ".agent-browser/browsers");
  if (!existsSync(base)) return undefined;
  const version = readdirSync(base)
    .filter((name) => name.startsWith("chrome-"))
    .sort()
    .at(-1);
  const binary = version && path.join(base, version, "chrome");
  return binary && existsSync(binary) ? binary : undefined;
}

const chrome = newestChrome();
const agentBrowser = path.join(state, "tools/ab/node_modules/.bin/agent-browser");
const pageBrowser = path.join(root, "infra/sandboxes/computer/rakazo-page-browser");
if (chrome && existsSync(agentBrowser) && existsSync(pageBrowser)) {
  set("RAKAZO_NATIVE_BROWSER", "1");
  set("RAKAZO_NATIVE_BROWSER_PORT", "9222");
  set("RAKAZO_NATIVE_CHROME_BIN", chrome);
  set("RAKAZO_NATIVE_BROWSER_PROFILE", path.join(state, "browser-profile"));
  set("RAKAZO_NATIVE_BROWSER_CACHE", "/dev/shm/rakazo/chrome-cache");
  set("RAKAZO_AGENT_BROWSER", agentBrowser);
  set("RAKAZO_NATIVE_PAGE_BROWSER", pageBrowser);
  console.log("Shared browser configured (profile on disk, cache in /dev/shm)");
} else {
  console.log("Shared browser not configured: run scripts/native/install-browser.sh first");
}

// The managed app catalog. Without it Integrations is empty; the key stays in a 600 file.
const composioKey = path.join(state, "composio.key");
if (existsSync(composioKey)) {
  set("COMPOSIO_API_KEY", read(composioKey));
  console.log("Composio app catalog configured");
}

writeFileSync(envFile, env, { mode: 0o600 });
chmodSync(envFile, 0o600);
console.log(`Wrote ${envFile} (mode 600)`);
console.log(`DATA_DIR=${dataDir}`);
const emailEmulator = env.match(/^EMAIL_EMULATOR=(.*)$/m)?.[1]?.trim() === "true";
console.log(
  `SANDBOX_PROVIDER=desktop, NODE_ENV=development, EMAIL_EMULATOR=${emailEmulator}`,
);
