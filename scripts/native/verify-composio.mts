#!/usr/bin/env node
// Checks the managed app catalog through Rakazo's own connector, not Composio's raw API.
//   pnpm exec tsx scripts/native/verify-composio.mts
import { readFileSync } from "node:fs";
import path from "node:path";
import { ComposioConnector } from "../../packages/adapters/src/providers/integration/composio/composio-connector.js";

for (const line of readFileSync(path.resolve(import.meta.dirname, "../../.env"), "utf8").split("\n")) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
}

const apiKey = process.env.COMPOSIO_API_KEY;
if (!apiKey) throw new Error("COMPOSIO_API_KEY is missing");

const context = {
  operationId: `verify-composio-${Date.now()}`,
  traceId: "verify-composio",
  spaceId: "verify-space",
  userId: "verify-user",
  signal: new AbortController().signal,
};

const connector = new ComposioConnector({ apiKey });
const results: Record<string, string[]> = {};
for (const query of ["gmail", "canva", "confluence"]) {
  const items = await connector.catalog(context, query);
  results[query] = items.slice(0, 5).map((item) => `${item.slug ?? item.name}`);
}
console.log(JSON.stringify(results, null, 2));
