#!/usr/bin/env node
// Prints the shared browser's tabs as another process (the API) sees them, including the bot that
// opened each. Run verify-browser.mts first.
import { readFileSync } from "node:fs";
import path from "node:path";
import { DesktopSandboxProvider } from "../../packages/adapters/src/providers/computer/desktop/desktop-sandbox.js";

for (const line of readFileSync(path.resolve(import.meta.dirname, "../../.env"), "utf8").split("\n")) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
}

const provider = new DesktopSandboxProvider({ root: process.env.DATA_DIR });
console.log(JSON.stringify((await provider.browserTabs?.()) ?? [], null, 2));
