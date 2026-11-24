#!/usr/bin/env node
// Writes .env for a native (no Docker) Rakazo install on this host.
//
//   node scripts/native/setup-env.mjs
//
// Secrets live in ~/.local/share/rakazo-native/{owner.pw,app.pw} (600) and are
// copied into .env without ever being printed. Rerunning keeps existing values.
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const state = path.join(homedir(), ".local/share/rakazo-native");
const envFile = path.join(root, ".env");
const example = path.join(root, ".env.example");
// Durable state (workspace, bot files) must survive a reboot, so it lives on disk.
// /dev/shm holds only cache, temp files and scratch data.
const dataDir = path.join(state, "data");

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
set("DATA_DIR", dataDir);
set("EMAIL_EMULATOR", "true");
set("SIGNUPS_ENABLED", "true");

writeFileSync(envFile, env, { mode: 0o600 });
chmodSync(envFile, 0o600);
console.log(`Wrote ${envFile} (mode 600)`);
console.log(`DATA_DIR=${dataDir}`);
console.log("SANDBOX_PROVIDER=desktop, NODE_ENV=development, EMAIL_EMULATOR=true");
