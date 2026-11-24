import { open, readFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Hono } from "hono";

/**
 * The native live link (scripts/native/tunnel.sh): its state, its log and the one way to stop it.
 * The script owns the Cloudflare quick tunnel and writes the files read here; nothing in this
 * module starts a tunnel, and every route answers 401 without a session, so a caller who is not
 * signed in never sees the log.
 */

export const NATIVE_RUNTIME_PATH = "/api/native/runtime";
export const NATIVE_RUNTIME_STOP_PATH = "/api/native/runtime/stop";

/** How many log lines a signed-in caller gets. */
export const NATIVE_RUNTIME_LOG_LINES = 100;
/** Reading starts this far from the end, so a runaway log is never loaded whole. */
const LOG_TAIL_BYTES = 256 * 1024;
/** How long a stop waits for tunnel.sh to see SIGTERM and write `stopped`. */
const STOP_WAIT_MS = 3000;
const STOP_POLL_MS = 200;

export type NativeRuntimeState = "running" | "stopped" | "error" | "off";

/** The shape scripts/native/status.sh prints and tunnel.sh writes to status.json. */
export interface NativeRuntimeStatus {
  state: NativeRuntimeState;
  url: string | null;
  since: string | null;
  pid: number | null;
  lastError: string | null;
}

export interface NativeRuntimeView extends NativeRuntimeStatus {
  /** Whole seconds since `since`; null unless the tunnel is running. */
  uptimeSeconds: number | null;
  /** The last lines of tunnel.log, newest last. */
  logs: string[];
}

export interface NativeRuntimeOptions {
  /** The state directory holding status.json and tunnel.log; defaults to the native one. */
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

const OFF: NativeRuntimeStatus = {
  state: "off",
  url: null,
  since: null,
  pid: null,
  lastError: null,
};

const STALE_TUNNEL =
  "The tunnel process is gone. Start it again with bash scripts/native/tunnel.sh.";

const STATES: ReadonlySet<string> = new Set(["running", "stopped", "error", "off"]);

/** Where the native scripts keep their state; the scripts honor the same override. */
export function nativeStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.RAKAZO_NATIVE_STATE_DIR?.trim();
  return override || path.join(homedir(), ".local", "share", "rakazo-native");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Anything the script could not have written is reported as off, never as a running tunnel. */
function normalizeStatus(raw: unknown): NativeRuntimeStatus {
  if (!isRecord(raw)) return { ...OFF };
  const state =
    typeof raw.state === "string" && STATES.has(raw.state)
      ? (raw.state as NativeRuntimeState)
      : "off";
  const pid =
    typeof raw.pid === "number" && Number.isInteger(raw.pid) && raw.pid > 1 ? raw.pid : null;
  return {
    state,
    url: nonEmptyText(raw.url),
    since: nonEmptyText(raw.since),
    pid,
    lastError: nonEmptyText(raw.lastError),
  };
}

async function readStatusFile(file: string): Promise<NativeRuntimeStatus> {
  try {
    const raw: unknown = JSON.parse(await readFile(file, "utf8"));
    return normalizeStatus(raw);
  } catch {
    return { ...OFF };
  }
}

/**
 * Whether the pid in status.json is still the tunnel. On Linux the command line proves it, so a
 * pid recycled by another process is not reported as running; elsewhere a live pid is all there is.
 */
async function tunnelProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return /cloudflared/i.test(await readFile(`/proc/${pid}/cmdline`, "utf8"));
  } catch {
    return true;
  }
}

async function readLogTail(file: string, lines = NATIVE_RUNTIME_LOG_LINES): Promise<string[]> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const length = size - start;
    if (length === 0) return [];
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const text = buffer.toString("utf8");
    // A byte window usually starts mid-line; that fragment is not a whole log line.
    const newline = start > 0 ? text.indexOf("\n") : -1;
    const complete = start > 0 && newline === -1 ? "" : text.slice(newline + 1);
    return complete
      .split("\n")
      .filter((line) => line !== "")
      .slice(-lines);
  } catch {
    return [];
  } finally {
    await handle?.close();
  }
}

export async function readNativeRuntime(
  options: NativeRuntimeOptions = {},
): Promise<NativeRuntimeView> {
  const dir = options.dir ?? nativeStateDir(options.env);
  const status = await readStatusFile(path.join(dir, "status.json"));
  let view: NativeRuntimeStatus = status;
  if (status.state === "running" && (!status.pid || !(await tunnelProcessAlive(status.pid)))) {
    view = { ...status, state: "error", url: null, pid: null, lastError: STALE_TUNNEL };
  }
  const logs = await readLogTail(path.join(dir, "tunnel.log"));
  const now = options.now?.() ?? Date.now();
  const sinceMs = view.since ? Date.parse(view.since) : Number.NaN;
  const uptimeSeconds =
    view.state === "running" && Number.isFinite(sinceMs)
      ? Math.max(0, Math.round((now - sinceMs) / 1000))
      : null;
  return { ...view, uptimeSeconds, logs };
}

/**
 * Asks the tunnel to stop the way tunnel.sh expects: SIGTERM, after which its trap closes
 * cloudflared and writes `stopped`. Stopping a stopped tunnel is not an error.
 */
export async function stopNativeTunnel(
  options: NativeRuntimeOptions = {},
): Promise<NativeRuntimeView> {
  const dir = options.dir ?? nativeStateDir(options.env);
  const status = await readStatusFile(path.join(dir, "status.json"));
  if (status.state !== "running" || !status.pid) return readNativeRuntime({ ...options, dir });
  if (!(await tunnelProcessAlive(status.pid))) return readNativeRuntime({ ...options, dir });
  try {
    process.kill(status.pid, "SIGTERM");
  } catch (error) {
    // A concurrent stop already took it down; the state file decides what is reported.
    if ((error as NodeJS.ErrnoException).code === "ESRCH")
      return readNativeRuntime({ ...options, dir });
    const message = error instanceof Error ? error.message : "unknown error";
    const view = await readNativeRuntime({ ...options, dir });
    return { ...view, state: "error", lastError: `Could not stop the tunnel: ${message}` };
  }
  const deadline = Date.now() + STOP_WAIT_MS;
  // Poll the file, not the view: the view turns a dead pid into `error` at once, while tunnel.sh
  // needs a moment to run its trap and write `stopped` for a termination it did not start.
  let written = await readStatusFile(path.join(dir, "status.json"));
  while (written.state === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
    written = await readStatusFile(path.join(dir, "status.json"));
  }
  const view = await readNativeRuntime({ ...options, dir });
  if (written.state === "running") {
    return { ...view, state: "error", lastError: "The tunnel did not stop in time." };
  }
  return view;
}

export interface NativeRuntimeDeps {
  /** The signed-in session; both routes answer 401 without one. */
  session: (request: Request) => Promise<{ user?: unknown } | null | undefined>;
  /** Read once when the route is mounted; tests pass their own state directory. */
  env?: NodeJS.ProcessEnv;
  dir?: string;
}

export function mountNativeRuntime(app: Hono, deps: NativeRuntimeDeps): void {
  const options: NativeRuntimeOptions = { env: deps.env, dir: deps.dir };

  app.get(NATIVE_RUNTIME_PATH, async (c) => {
    c.header("cache-control", "no-store");
    if (!(await deps.session(c.req.raw))?.user) return c.json({ error: "Unauthorized" }, 401);
    return c.json(await readNativeRuntime(options));
  });

  app.post(NATIVE_RUNTIME_STOP_PATH, async (c) => {
    c.header("cache-control", "no-store");
    if (!(await deps.session(c.req.raw))?.user) return c.json({ error: "Unauthorized" }, 401);
    // A JSON content type forces a CORS preflight, so a cross-site page cannot stop the tunnel
    // with a form post. The same guard as the user-device pairing route.
    if (!c.req.header("content-type")?.startsWith("application/json"))
      return c.json({ error: "Expected JSON" }, 415);
    return c.json(await stopNativeTunnel(options));
  });
}
