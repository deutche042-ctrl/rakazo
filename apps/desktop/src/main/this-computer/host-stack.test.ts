import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostStackDeps } from "./host-stack.js";
import { HOST_LOCAL_WEB_URL, HostStackController, resolveHostProjectRoot } from "./host-stack.js";
import { ensureStackToken } from "./local-stack.js";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  constructor(
    readonly pid: number,
    readonly args: string[],
    readonly options: Parameters<NonNullable<HostStackDeps["spawn"]>>[2],
  ) {
    super();
  }
  kill() {
    this.exit(0);
    return true;
  }
  exit(code = 0) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    queueMicrotask(() => this.emit("exit", code, null));
  }
}

interface Spawned {
  child: FakeChild;
  command: string;
  args: string[];
  options: Parameters<NonNullable<HostStackDeps["spawn"]>>[2];
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rakazo-host-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A sleep that still lets timers and child events run, so a stuck loop cannot spin. */
const fastSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.min(ms, 2));
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

function harness(overrides: Partial<HostStackDeps> = {}, onSpawn?: (child: FakeChild) => void) {
  const projectRoot = path.join(root, "checkout");
  const stackDir = path.join(root, "stack");
  const spawned: Spawned[] = [];
  const killed: { pid: number; signal: NodeJS.Signals }[] = [];
  const spawn: HostStackDeps["spawn"] = (command, args, options) => {
    const child = new FakeChild(10_000 + spawned.length, args, options);
    spawned.push({ child, command, args, options });
    onSpawn?.(child);
    return child as unknown as ChildProcess;
  };
  const probe = vi.fn(async () => null as string | null);
  const health = vi.fn(async () => false);
  const deps: HostStackDeps = {
    stackDir,
    projectRoot,
    localWebUrl: HOST_LOCAL_WEB_URL,
    imageTag: "native",
    env: { HOME: "/home/tester", PATH: "/usr/local/bin:/usr/bin:/bin" },
    probe,
    health,
    randomHex: () => "ab".repeat(32),
    spawn,
    sleep: fastSleep,
    portFree: async () => true,
    killGroup: (pid, signal) => {
      killed.push({ pid, signal });
      spawned.find((entry) => entry.child.pid === pid)?.child.exit(0);
    },
    ...overrides,
  };
  return { deps, projectRoot, stackDir, spawned, killed, probe, health };
}

/** The checkout `start.sh` a controller is expected to run. */
async function withCheckout(projectRoot: string) {
  await mkdir(path.join(projectRoot, "scripts", "native"), { recursive: true });
  await writeFile(path.join(projectRoot, "scripts", "native", "start.sh"), "#!/usr/bin/env bash\n");
  return path.join(projectRoot, "scripts", "native", "start.sh");
}

describe("resolveHostProjectRoot", () => {
  it("takes the explicit checkout, then the workspace an unpackaged app runs in", () => {
    expect(
      resolveHostProjectRoot({
        packaged: true,
        appPath: "/opt/Rakazo/resources/app.asar",
        env: { RAKAZO_NATIVE_ROOT: "/work/rakazo" },
      }),
    ).toBe("/work/rakazo");
    expect(
      resolveHostProjectRoot({
        packaged: false,
        appPath: "/work/rakazo/apps/desktop",
        env: {},
      }),
    ).toBe("/work/rakazo");
    expect(
      resolveHostProjectRoot({ packaged: true, appPath: "/opt/Rakazo/app.asar", env: {} }),
    ).toBeNull();
  });
});

describe("HostStackController", () => {
  it("adopts a stack that answers health without spawning anything", async () => {
    const ui = harness();
    await withCheckout(ui.projectRoot);
    ui.health.mockResolvedValue(true);
    const states: string[] = [];
    ui.deps.onState = (state) => states.push(state.phase);

    const controller = new HostStackController(ui.deps);
    const state = await controller.start();

    expect(state.phase).toBe("ready");
    expect(ui.spawned).toHaveLength(0);
    expect(controller.hasProcesses()).toBe(false);
    expect(controller.managedStackRunning()).toBe(false);
    expect(states).toEqual(["checking-docker", "ready"]);
  });

  it("starts the checkout's stack, then reports ready once the token probe matches", async () => {
    const ui = harness();
    const startScript = await withCheckout(ui.projectRoot);
    ui.probe.mockResolvedValue("native");

    const controller = new HostStackController(ui.deps);
    const state = await controller.start();

    expect(state.phase).toBe("ready");
    expect(ui.spawned).toHaveLength(1);
    expect(ui.spawned[0]?.command).toBe("/bin/bash");
    expect(ui.spawned[0]?.args).toEqual([startScript]);
    expect(ui.spawned[0]?.options).toMatchObject({ cwd: ui.projectRoot, detached: true });
    expect(ui.spawned[0]?.options.env).toMatchObject({
      RAKAZO_NATIVE_ROOT: ui.projectRoot,
      WEB_PORT: "5173",
      API_PORT: "3100",
      RAKAZO_HOST: "localhost",
      BETTER_AUTH_URL: HOST_LOCAL_WEB_URL,
      WEB_ORIGIN: HOST_LOCAL_WEB_URL,
      API_URL: "http://localhost:3100",
      RAKAZO_IMAGE_TAG: "native",
      SANDBOX_PROVIDER: "desktop",
      SANDBOX_COMPUTER_EGRESS: "open",
      CONTENT_ENCRYPTION: "off",
      MCP_ALLOW_PRIVATE_ENDPOINT: "true",
      PATH: "/usr/local/bin:/usr/bin:/bin",
    });
    expect(ui.spawned[0]?.options.env.RAKAZO_DESKTOP_STACK_TOKEN).toMatch(/^[a-f0-9]{64}$/);
    expect(controller.hasProcesses()).toBe(true);
  });

  it("adopts the server health finds after spawning one without a token", async () => {
    const ui = harness();
    await withCheckout(ui.projectRoot);
    ui.probe.mockResolvedValue(null);
    // Not up when the attempt starts, answering by the time the first poll runs.
    ui.health.mockResolvedValueOnce(false).mockResolvedValue(true);

    const controller = new HostStackController(ui.deps);
    const state = await controller.start();

    expect(state.phase).toBe("ready");
    expect(ui.spawned).toHaveLength(1);
  });

  it("reports a child that exits while starting, with its last output", async () => {
    const ui = harness({}, (child) => {
      child.stdout.write("boom: vite failed\n");
      setTimeout(() => child.exit(1), 5);
    });
    await withCheckout(ui.projectRoot);
    ui.health.mockResolvedValue(false);
    ui.probe.mockResolvedValue(null);

    const controller = new HostStackController(ui.deps);
    const state = await controller.start();

    expect(state.phase).toBe("failed");
    expect(state.message).toBe(
      "Rakazo services did not start. Check the output below, then retry.",
    );
    expect(state.output).toContain("boom: vite failed");
  });

  it("names the checkout command when no checkout can be started", async () => {
    const ui = harness({ projectRoot: null });

    const controller = new HostStackController(ui.deps);
    const state = await controller.start();

    expect(state.phase).toBe("failed");
    expect(state.message).toBe("Could not start the local stack. Try again.");
    expect(state.output?.join("\n")).toContain("bash scripts/native/start.sh");
    expect(state.message).not.toMatch(/docker/i);
    expect(state.output?.join("\n")).not.toMatch(/docker/i);
    expect(ui.spawned).toHaveLength(0);
  });

  it("stops the process group it started and returns to idle", async () => {
    const ui = harness();
    await withCheckout(ui.projectRoot);
    ui.probe.mockResolvedValue("native");
    const controller = new HostStackController(ui.deps);
    await controller.start();
    const child = ui.spawned[0]?.child;

    const state = await controller.stop();

    expect(state.phase).toBe("idle");
    expect(ui.killed).toEqual([{ pid: child?.pid as number, signal: "SIGTERM" }]);
    expect(controller.hasProcesses()).toBe(false);
  });

  it("falls back to health when the private token probe fails", async () => {
    const ui = harness();
    await mkdir(ui.stackDir, { recursive: true });
    await ensureStackToken(ui.stackDir, () => "ab".repeat(32));
    ui.probe.mockResolvedValue(null);
    ui.health.mockResolvedValue(true);

    const controller = new HostStackController(ui.deps);
    await expect(controller.matchesDesiredStack()).resolves.toBe(true);
    expect(ui.probe).toHaveBeenCalledOnce();

    ui.health.mockResolvedValue(false);
    await expect(controller.matchesDesiredStack()).resolves.toBe(false);
  });
});
