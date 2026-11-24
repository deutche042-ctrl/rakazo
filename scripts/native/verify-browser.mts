#!/usr/bin/env node
// Drives the desktop provider's page browser against the shared Chromium.
//   node scripts/native/setup-env.mjs && bash scripts/native/browser.sh
//   pnpm exec tsx scripts/native/verify-browser.mts
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DesktopSandboxProvider } from "../../packages/adapters/src/providers/computer/desktop/desktop-sandbox.js";

// The repo does not hoist dotenv, so read the file we wrote ourselves.
for (const line of readFileSync(path.resolve(import.meta.dirname, "../../.env"), "utf8").split("\n")) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
}

const dataDir = process.env.DATA_DIR;
if (!dataDir) throw new Error("DATA_DIR is missing; run scripts/native/setup-env.mjs");

const context = {
  operationId: `verify-browser-${Date.now()}`,
  traceId: "verify-browser",
  spaceId: "verify-space",
  userId: "verify-user",
  botId: "verify-bot",
  signal: new AbortController().signal,
};

const provider = new DesktopSandboxProvider({ root: dataDir });
if (!provider.pageBrowser) throw new Error("pageBrowser is not configured (see RAKAZO_NATIVE_*)");

const ref = await provider.provision(
  { botId: "verify-browser", homePath: path.join(dataDir, "homes", "verify-browser") },
  context,
);

const navigated = await provider.pageBrowser(
  ref,
  { command: "navigate", url: "https://example.com" },
  context,
);
const snapshot = await provider.pageBrowser(ref, { command: "snapshot" }, context);
const tabs = (await provider.browserTabs?.()) ?? [];
const observation = await provider.observe(ref, context);
writeFileSync("/tmp/rakazo-frame.jpg", observation.image);

const passed = navigated.ok === true && snapshot.ok === true && (snapshot.elements?.length ?? 0) > 0;
if (!passed) {
  // A structured failure resolves with ok: false and a zero exit status, so this script must fail
  // itself or a broken browser would look green.
  console.error("Browser verification failed");
  process.exitCode = 1;
}

console.log(
  JSON.stringify(
    {
      navigate: { ok: navigated.ok, url: navigated.url, title: navigated.title },
      snapshot: {
        ok: snapshot.ok,
        url: snapshot.url,
        elements: snapshot.elements?.slice(0, 4),
        tree: snapshot.tree?.slice(0, 160),
      },
      tabs,
      capture: {
        mimeType: observation.mimeType,
        width: observation.width,
        height: observation.height,
        bytes: observation.image.byteLength,
      },
    },
    null,
    2,
  ),
);
