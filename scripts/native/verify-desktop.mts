#!/usr/bin/env node
// Proves the native desktop provider behaves as the native setup expects:
//  - commands run as this OS user on this host
//  - two bots that share a home key share one workspace directory
//  - a private computer keeps its own directory
//
//   NODE_ENV=development pnpm exec tsx scripts/native/verify-desktop.mts
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DesktopSandboxProvider } from "../../packages/adapters/src/providers/computer/desktop/desktop-sandbox.js";

const dataDir = process.env.DATA_DIR ?? "/dev/shm/rakazo/data";
const teams = path.join(dataDir, "homes");

function context(botId: string) {
  return {
    operationId: `verify-${botId}-${Date.now()}`,
    traceId: `trace-${botId}`,
    spaceId: "verify-space",
    userId: "verify-user",
    botId,
    signal: new AbortController().signal,
  };
}

async function run(provider: DesktopSandboxProvider, computer: any, argv: string[]) {
  const out: string[] = [];
  let code = -1;
  for await (const event of provider.execute(computer, { argv, timeoutMs: 10_000 }, context(computer.botId))) {
    if (event.type === "stdout") out.push(event.data);
    if (event.type === "stderr") out.push(`[stderr] ${event.data}`);
    if (event.type === "exit") code = event.code;
  }
  return { code, out: out.join("").trim() };
}

await mkdir(teams, { recursive: true });

// The API passes a computer's home key as the provision botId (computer-lifecycle.ts).
const teamHomeKey = "team-home-key";
const privateHomeKey = "private-home-key";

const botA = new DesktopSandboxProvider({ root: dataDir });
const botB = new DesktopSandboxProvider({ root: dataDir });
const botC = new DesktopSandboxProvider({ root: dataDir });

const a = await botA.provision({ botId: teamHomeKey, homePath: path.join(teams, teamHomeKey) }, context("bot-a"));
const b = await botB.provision({ botId: teamHomeKey, homePath: path.join(teams, teamHomeKey) }, context("bot-b"));
const c = await botC.provision({ botId: privateHomeKey, homePath: path.join(teams, privateHomeKey) }, context("bot-c"));

const who = await run(botA, a, ["sh", "-c", "id -un; hostname; pwd; echo HOME=$HOME"]);
await run(botA, a, ["sh", "-c", "printf 'shared-file' > shared-proof.txt"]);
const seen = await run(botB, b, ["sh", "-c", "cat shared-proof.txt 2>&1; pwd"]);
const isolated = await run(botC, c, ["sh", "-c", "cat shared-proof.txt 2>&1 || true; pwd"]);

console.log(JSON.stringify({
  dataDir,
  teamHomeA: a.providerRef,
  teamHomeB: b.providerRef,
  privateHome: c.providerRef,
  sameTeamHome: a.providerRef === b.providerRef,
  host: who,
  secondBotSeesFirstBotsFile: seen.out.includes("shared-file"),
  privateCannotSeeTeamFile: !isolated.out.includes("shared-file"),
  secondBot: seen.out,
  private: isolated.out,
  proofContent: await readFile(path.join(a.providerRef, "shared-proof.txt"), "utf8").catch(() => null),
}, null, 2));
