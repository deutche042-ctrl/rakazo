// This computer with no Docker and no VM: the API, worker and web are the checkout's own
// `scripts/native/start.sh` processes on loopback, and the app adopts a stack that is already up.
// Drives the same state and events as the Docker controller, so the setup screen is unchanged.
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { DesktopLocalStackState } from "@rakazo/contracts";
import { t } from "../i18n.js";
import {
  defaultSleep,
  ensureStackToken,
  initialStackState,
  portFreeOnLoopback,
  readStackToken,
  StackLifecycle,
  startInterrupted,
} from "./local-stack.js";

/** Passkeys need the `localhost` origin, never the loopback IP, so the app opens this one. */
export const HOST_LOCAL_WEB_URL = "http://localhost:5173";
export const HOST_API_URL = "http://localhost:3100";
/** Fixed, because the sign-in origin and the probes are pinned to these ports. */
const HOST_WEB_PORT = 5173;
const HOST_API_PORT = 3100;
/** The image tag the checkout's stack reports, so a probe tells it apart from any other server. */
const HOST_IMAGE_TAG = "native";
const HEALTH_POLL_INTERVAL_MS = 1_000;
const PORT_WAIT_TIMEOUT_MS = 20_000;
const START_TIMEOUT_MS = 5 * 60_000;
const STOP_GRACE_MS = 10_000;
const LOG_TAIL_LINES = 12;

/** Process environment the checkout's scripts may inherit; everything else comes from `.env`. */
const INHERITED_ENV = [
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

export type HostStackProbe = (
  url: string,
  signal: AbortSignal,
  token: string,
) => Promise<string | null>;
export type HostStackHealth = (url: string, signal: AbortSignal) => Promise<boolean>;

export type SpawnHostStack = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    detached: true;
    stdio: ["ignore", "pipe", "pipe"];
    env: Record<string, string>;
  },
) => ChildProcess;

/** Runs the script through bash's argument list only; the path is never part of a command line. */
const spawnHostStack: SpawnHostStack = (_command, args, options) =>
  spawn("/bin/bash", args, { ...options, shell: false });
const killGroup = (pid: number, signal: NodeJS.Signals) => process.kill(-pid, signal);

/**
 * The checkout the stack starts from: an explicit `RAKAZO_NATIVE_ROOT`, the workspace an
 * unpackaged app runs inside, or nothing for a packaged app that was not pointed at one.
 */
export function resolveHostProjectRoot(input: {
  packaged: boolean;
  appPath: string;
  env: NodeJS.ProcessEnv;
}): string | null {
  const configured = input.env.RAKAZO_NATIVE_ROOT?.trim();
  if (configured) return configured;
  if (input.packaged) return null;
  return path.resolve(input.appPath, "..", "..");
}

export interface HostStackDeps {
  stackDir: string;
  /** Null when there is no checkout to start; an already running stack can still be adopted. */
  projectRoot: string | null;
  localWebUrl: string;
  imageTag: string;
  env: NodeJS.ProcessEnv;
  hostComputer?: { url: string; token: string };
  /** Returns the authenticated running image tag, or null for any other listener. */
  probe: HostStackProbe;
  /** An unauthenticated Rakazo health answer; the app adopts a stack started outside it. */
  health: HostStackHealth;
  randomHex: (bytes: number) => string;
  spawn?: SpawnHostStack;
  exists?: (file: string) => boolean;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  portFree?: (port: number) => Promise<boolean>;
  /** Signals the whole process group, so the pnpm children of `start.sh` stop too. */
  killGroup?: (pid: number, signal: NodeJS.Signals) => void;
  onState?: (state: DesktopLocalStackState) => void;
}

/** Builds the controller for the shared stack deps, pinning the host URL and its image tag. */
export function createHostStack(
  shared: Pick<HostStackDeps, "stackDir" | "probe" | "randomHex" | "onState">,
  options: Omit<
    HostStackDeps,
    "stackDir" | "probe" | "randomHex" | "onState" | "localWebUrl" | "imageTag" | "projectRoot"
  > & { localWebUrl?: string; projectRoot?: string | null; packaged?: boolean; appPath?: string },
): HostStackController {
  const projectRoot =
    options.projectRoot !== undefined
      ? options.projectRoot
      : options.packaged !== undefined && options.appPath !== undefined
        ? resolveHostProjectRoot({
            packaged: options.packaged,
            appPath: options.appPath,
            env: options.env,
          })
        : null;
  return new HostStackController({
    stackDir: shared.stackDir,
    probe: shared.probe,
    randomHex: shared.randomHex,
    onState: shared.onState,
    ...options,
    projectRoot,
    localWebUrl:
      options.localWebUrl?.trim() ||
      options.env.RAKAZO_LOCAL_WEB_URL?.trim() ||
      HOST_LOCAL_WEB_URL,
    imageTag: HOST_IMAGE_TAG,
  });
}

class StartFailure extends Error {
  constructor(
    readonly userMessage: string,
    readonly output: string[] = [],
  ) {
    super(userMessage);
  }
}

/** A translated line for the phase, with the specific cause left to the output below it. */
const couldNotStart = () => t("Could not start the local stack. Try again.");
const servicesFailed = () =>
  t("Rakazo services did not start. Check the output below, then retry.");
const portInUseDetail = "Port 5173 is already in use by another program. Quit it, then retry.";
const missingCheckoutDetail = "Run bash scripts/native/start.sh in the Rakazo checkout, then retry.";

/**
 * Runs, or adopts, the checkout's stack on this host. A stack this app started stops with the
 * app; one it adopted stays, since another checkout started it.
 */
export class HostStackController extends StackLifecycle {
  private child: ChildProcess | null = null;
  private childExit: { code: number | null; signal: string | null } | null = null;
  private currentStackToken: string | null = null;
  private tail: string[] = [];

  constructor(private readonly deps: HostStackDeps) {
    super(deps.imageTag, deps.localWebUrl, deps.onState);
  }

  /** True while the checkout's processes this app started are still running. */
  hasProcesses(): boolean {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
  }

  /** Only processes this app started get the off-switch; an adopted stack belongs to its checkout. */
  managedStackRunning(): boolean {
    return this.hasProcesses();
  }

  /** The private token proves the stack is ours; an unauthenticated health answer adopts it. */
  async matchesDesiredStack(): Promise<boolean> {
    if (this.stopInFlight()) return false;
    const token = await readStackToken(this.deps.stackDir);
    if (token !== null) {
      try {
        const probed = await this.deps.probe(this.currentWebUrl, AbortSignal.timeout(2_000), token);
        if (probed === this.deps.imageTag) {
          this.currentStackToken = token;
          return true;
        }
      } catch {
        // A stack started by hand has no token; the health check below still finds it.
      }
    }
    const healthy = await this.reachable();
    if (healthy) this.currentStackToken = null;
    return healthy;
  }

  private reachable(): Promise<boolean> {
    return this.deps.health(this.currentWebUrl, AbortSignal.timeout(2_000)).catch(() => false);
  }

  /** Stops the processes this app started; Postgres and the data stay for the next start. */
  protected async shutdown() {
    await this.stopChild();
    this.setState(initialStackState(this.deps.imageTag));
  }

  protected async attemptFailed(error: unknown, signal: AbortSignal) {
    await this.stopChild();
    if (signal.aborted) {
      this.push({ type: "failed", message: startInterrupted() });
    } else if (error instanceof StartFailure) {
      this.push({ type: "failed", message: error.userMessage, output: error.output });
    } else {
      this.push({
        type: "failed",
        message: servicesFailed(),
        output: [...this.tail, error instanceof Error ? error.message : String(error)],
      });
    }
  }

  protected async attempt(signal: AbortSignal) {
    this.tail = [];
    this.childExit = null;
    this.push({ type: "check-start" });
    // A stack already up, from this checkout or started by hand, is used as it is.
    if (await this.matchesDesiredStack()) {
      // A stop that began during the probe will end the server it answered from.
      if (signal.aborted) throw new StartFailure(startInterrupted());
      this.push({ type: "ready" });
      return;
    }
    this.push({ type: "prepare" });
    await mkdir(this.deps.stackDir, { recursive: true, mode: 0o700 });
    this.currentStackToken = await ensureStackToken(this.deps.stackDir, this.deps.randomHex);

    const projectRoot = this.deps.projectRoot;
    const startScript =
      projectRoot === null ? null : path.join(projectRoot, "scripts", "native", "start.sh");
    const exists = this.deps.exists ?? existsSync;
    if (startScript === null || !exists(startScript))
      throw new StartFailure(couldNotStart(), [missingCheckoutDetail]);

    if (!(await (this.deps.portFree ?? portFreeOnLoopback)(HOST_WEB_PORT))) {
      if (await this.waitForAdoption(signal)) return;
      throw new StartFailure(couldNotStart(), [portInUseDetail]);
    }

    this.push({ type: "up-start" });
    const child = (this.deps.spawn ?? spawnHostStack)("/bin/bash", [startScript], {
      cwd: projectRoot,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: this.startEnv(projectRoot),
    });
    this.child = child;
    this.forward(child.stdout, child.stderr);
    child.once("exit", (code, exitSignal) => {
      this.childExit = { code, signal: exitSignal };
    });
    child.once("error", (error) => {
      this.childExit = { code: null, signal: null };
      this.push({ type: "output", line: error.message });
    });

    this.push({ type: "wait-start" });
    await this.waitUntilReady(child, signal);
  }

  /** A listener on our port that turns out to be a Rakazo server is adopted, not a conflict. */
  private async waitForAdoption(signal: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + PORT_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (signal.aborted) throw new StartFailure(startInterrupted());
      if (await this.reachable()) {
        if (signal.aborted) throw new StartFailure(startInterrupted());
        this.currentStackToken = null;
        this.push({ type: "ready" });
        return true;
      }
      await this.sleep(HEALTH_POLL_INTERVAL_MS, signal);
    }
    return false;
  }

  private async waitUntilReady(child: ChildProcess, signal: AbortSignal) {
    const deadline = Date.now() + START_TIMEOUT_MS;
    const { probe, health, imageTag } = this.deps;
    while (Date.now() < deadline) {
      if (signal.aborted) throw new StartFailure(startInterrupted(), this.tail);
      if (this.childExit !== null) throw new StartFailure(servicesFailed(), this.tail);
      if (this.currentStackToken !== null) {
        const probed = await probe(
          this.currentWebUrl,
          AbortSignal.timeout(HEALTH_POLL_INTERVAL_MS),
          this.currentStackToken,
        ).catch(() => null);
        if (probed === imageTag) {
          if (signal.aborted) throw new StartFailure(startInterrupted(), this.tail);
          this.push({ type: "ready" });
          return;
        }
      }
      if (await this.reachable()) {
        if (signal.aborted) throw new StartFailure(startInterrupted(), this.tail);
        this.currentStackToken = null;
        this.push({ type: "ready" });
        return;
      }
      // A process that exited during the probe never reaches a phase change of its own.
      if (this.childExit !== null || child.exitCode !== null || child.signalCode !== null) {
        throw new StartFailure(servicesFailed(), this.tail);
      }
      await this.sleep(HEALTH_POLL_INTERVAL_MS, signal);
    }
    throw new StartFailure(servicesFailed(), this.tail);
  }

  private forward(...streams: (NodeJS.ReadableStream | null)[]) {
    for (const stream of streams) {
      if (stream === null) continue;
      stream.setEncoding("utf8");
      let pending = "";
      stream.on("data", (text: string) => {
        const lines = `${pending}${text}`.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim() === "") continue;
          this.tail = [...this.tail, line].slice(-LOG_TAIL_LINES);
          this.push({ type: "output", line });
        }
      });
    }
  }

  /** What `start.sh` and the API it launches read: the checkout's `.env` fills everything else. */
  private startEnv(projectRoot: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of INHERITED_ENV) {
      const value = this.deps.env[name];
      if (value) env[name] = value;
    }
    env.PATH = this.deps.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
    return {
      ...env,
      RAKAZO_NATIVE_ROOT: projectRoot,
      WEB_PORT: String(HOST_WEB_PORT),
      API_PORT: String(HOST_API_PORT),
      RAKAZO_HOST: "localhost",
      BETTER_AUTH_URL: this.deps.localWebUrl,
      WEB_ORIGIN: this.deps.localWebUrl,
      API_URL: HOST_API_URL,
      RAKAZO_DESKTOP_STACK_TOKEN: this.currentStackToken ?? "",
      RAKAZO_IMAGE_TAG: this.deps.imageTag,
      SANDBOX_PROVIDER: "desktop",
      SANDBOX_HOST_URL: this.deps.hostComputer?.url ?? "",
      SANDBOX_HOST_TOKEN: this.deps.hostComputer?.token ?? "",
      SANDBOX_COMPUTER_EGRESS: "open",
      CONTENT_ENCRYPTION: "off",
      MCP_ALLOW_PRIVATE_ENDPOINT: "true",
    };
  }

  private sleep(ms: number, signal: AbortSignal) {
    return (this.deps.sleep ?? defaultSleep)(ms, signal);
  }

  private async stopChild() {
    const child = this.child;
    this.child = null;
    if (child === null || child.exitCode !== null || child.signalCode !== null) return;
    const pid = child.pid;
    const signal = (name: NodeJS.Signals) => {
      try {
        if (pid === undefined) child.kill(name);
        else (this.deps.killGroup ?? killGroup)(pid, name);
      } catch {
        // The process group is already gone.
      }
    };
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    signal("SIGTERM");
    const timer = setTimeout(() => signal("SIGKILL"), STOP_GRACE_MS);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
}
