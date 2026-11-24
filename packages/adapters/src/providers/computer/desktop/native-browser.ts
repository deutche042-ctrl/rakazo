import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import type {
  BrowserTabInfo,
  ComputerInput,
  PageBrowserCommand,
  PageBrowserResult,
} from "@rakazo/adapter-kit";

/** The supervisor's own limits, so a native page browser answers like the in-container one. */
const MAX_OUTPUT_BYTES = 512 * 1024;
const COMMAND_TIMEOUT_MS = 25_000;
/** Longer than one command, so a lock left by a crashed process frees itself. */
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 30_000;

export interface NativeBrowserOptions {
  /** Loopback CDP port of the one shared Chromium. */
  port: number;
  /** Rakazo's own page-browser helper (infra/sandboxes/computer/rakazo-page-browser). */
  helper: string;
  agentBrowser: string;
}

/**
 * Reads the native browser configuration. Absent or incomplete leaves the desktop provider
 * command-only, so a host without a browser installed behaves exactly as before.
 */
export function nativeBrowserOptions(
  env: NodeJS.ProcessEnv = process.env,
): NativeBrowserOptions | undefined {
  if (env.RAKAZO_NATIVE_BROWSER !== "1") return undefined;
  const helper = env.RAKAZO_NATIVE_PAGE_BROWSER?.trim();
  const agentBrowser = env.RAKAZO_AGENT_BROWSER?.trim();
  if (!helper || !agentBrowser) return undefined;
  const port = Number(env.RAKAZO_NATIVE_BROWSER_PORT ?? 9222);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  return { port, helper, agentBrowser };
}

/** Only what the helper and agent-browser need. Server secrets stay out of the child. */
const INHERITED_ENV = [
  "PATH",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "TMPDIR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
];

function browserEnvironment(home: string, options: NativeBrowserOptions) {
  const env: NodeJS.ProcessEnv = {};
  for (const name of INHERITED_ENV) env[name] = process.env[name];
  env.HOME = home;
  env.RAKAZO_CDP_PORT = String(options.port);
  env.RAKAZO_AGENT_BROWSER = options.agentBrowser;
  // The request goes over stdin. argv carries only a fixed command word, and no stdin watcher
  // may run after the pipe closes or the helper would treat that as an interrupt.
  env.RAKAZO_BROWSER_ARGS_STDIN = "1";
  delete env.RAKAZO_BROWSER_WATCH_STDIN;
  return env;
}

/** The helper's four subcommands, written out so no caller string becomes an argv entry. */
type HelperCommand = "navigate" | "snapshot" | "act" | "purchase_check";

function helperCommand(command: PageBrowserCommand["command"]): HelperCommand {
  switch (command) {
    case "navigate":
      return "navigate";
    case "snapshot":
      return "snapshot";
    case "act":
      return "act";
    case "purchase_check":
      return "purchase_check";
    default:
      throw new Error("Unsupported page browser command");
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/** The JPEG's declared size, so the panel can map a click without a second CDP round trip. */
function jpegSize(data: Buffer): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = data[offset + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
    }
    offset += 2 + data.readUInt16BE(offset + 2);
  }
  return undefined;
}

/** One directory for every process on this host: the API, the worker and the helper scripts. */
function browserStateDir(): string {
  return (
    process.env.RAKAZO_NATIVE_BROWSER_STATE?.trim() ||
    (existsSync("/dev/shm") ? "/dev/shm/rakazo" : tmpdir())
  );
}

/** One lock per display, because the API and the worker are separate processes. */
export function browserLockPath(port: number): string {
  return path.join(browserStateDir(), `rakazo-browser-${port}.lock`);
}

/**
 * Runs `fn` while holding an exclusive lock file. A lock older than one command belongs to a
 * process that died; remove it and try again.
 */
export async function withBrowserLock<T>(lock: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    let handle;
    try {
      handle = await open(lock, "wx", 0o600);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const age = await stat(lock).then(
        (info) => Date.now() - info.mtimeMs,
        () => 0,
      );
      if (age > LOCK_STALE_MS) {
        await unlink(lock).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline) throw new Error("Timed out waiting for the shared browser");
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      return await fn();
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(lock).catch(() => undefined);
    }
  }
}

/** Kills the helper and the agent-browser it started, not just the helper. */
function killTree(child: ReturnType<typeof spawn>) {
  if (!child.pid) return;
  try {
    // The child leads its own group (detached), so this reaches its descendants too.
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

export class NativeBrowser {
  private tail: Promise<unknown> = Promise.resolve();
  /** Target id → the bot that last worked in that tab. */
  private readonly owned = new Map<string, string>();
  /** Bot → the tab it last worked in, so a snapshot keeps the same attribution. */
  private readonly botTab = new Map<string, string>();
  /** The URL the last command ended on, which names its tab even when the URL did not change. */
  private lastResultUrl?: string;

  constructor(private readonly options: NativeBrowserOptions) {}

  /**
   * One browser serves every bot, so its commands run one at a time. The helper's session is bound
   * to the display, and two commands naming element refs at once would read each other's page. The
   * in-process queue is not enough: the API and the worker each build their own provider, so a lock
   * file beside the display serializes them too.
   */
  run(
    request: PageBrowserCommand,
    home: string,
    botId: string,
    signal?: AbortSignal,
  ): Promise<PageBrowserResult> {
    const work = () =>
      this.withLock(async () => {
        // A tab this command creates or navigates is the bot's; a snapshot keeps the previous one.
        const before = await this.tabUrls();
        const result = await this.execute(request, home, signal);
        await this.rememberOwner(botId, before);
        return result;
      });
    const next = this.tail.then(work, work);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** The open tabs, each with the bot that opened it when one was seen working there. */
  async listTabs(): Promise<BrowserTabInfo[]> {    try {
      const response = await fetch(`http://127.0.0.1:${this.options.port}/json/list`, {
        signal: AbortSignal.timeout(2_000),
      });
      const tabs = (await response.json()) as Array<{
        id?: unknown;
        title?: unknown;
        url?: unknown;
        type?: unknown;
      }>;
      if (!Array.isArray(tabs)) return [];
      const liveIds = new Set<string>();
      const shared = await this.readOwners();
      const result: BrowserTabInfo[] = [];
      for (const tab of tabs) {
        if (tab.type !== "page" || typeof tab.id !== "string") continue;
        const url = typeof tab.url === "string" ? tab.url : "";
        const title = typeof tab.title === "string" ? tab.title : "";
        // Chromium starts on a blank tab; it is not something a bot opened.
        if (url === "about:blank" && !title) continue;
        liveIds.add(tab.id);
        result.push({
          id: tab.id,
          title,
          url,
          botId: this.owned.get(tab.id) ?? shared[tab.id] ?? null,
        });
      }
      for (const id of this.owned.keys()) if (!liveIds.has(id)) this.owned.delete(id);
      return result;
    } catch {
      return [];
    }
  }

  /** A JPEG of the tab this bot last worked in. Never another bot's tab. */
  async capture(
    botId?: string,
  ): Promise<{ image: Buffer; mimeType: "image/jpeg"; width: number; height: number } | undefined> {
    const url = await this.pageSocketUrl(botId);
    if (!url) return undefined;
    const result = await this.sendCdp<{ data?: unknown }>(url, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 60,
      fromSurface: true,
      captureBeyondViewport: false,
    });
    if (typeof result.data !== "string") return undefined;
    const image = Buffer.from(result.data, "base64");
    const size = jpegSize(image) ?? { width: 0, height: 0 };
    return { image, mimeType: "image/jpeg", ...size };
  }

  /** Drives the tab this bot last worked in. Coordinates are CSS pixels of the captured page. */
  async input(botId: string | undefined, input: ComputerInput): Promise<void> {
    const url = await this.pageSocketUrl(botId);
    if (!url) return;
    const commands: Array<{ method: string; params: Record<string, unknown> }> = [];
    if (input.kind === "pointer") {
      const params = { x: input.x, y: input.y, button: input.button ?? "left", clickCount: 1 };
      if (input.type === "move")
        commands.push({
          method: "Input.dispatchMouseEvent",
          params: { type: "mouseMoved", ...params, button: "none" },
        });
      if (input.type === "down" || input.type === "click")
        commands.push({ method: "Input.dispatchMouseEvent", params: { type: "mousePressed", ...params } });
      if (input.type === "up" || input.type === "click")
        commands.push({ method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", ...params } });
    } else if (input.kind === "key") {
      if (input.key.length === 1) {
        commands.push({ method: "Input.insertText", params: { text: input.key } });
      } else {
        commands.push({ method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: input.key } });
        commands.push({ method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: input.key } });
      }
    } else {
      commands.push({ method: "Input.insertText", params: { text: input.text } });
    }
    if (commands.length) await this.sendCdpBatch(url, commands);
  }

  private async pageSocketUrl(botId?: string): Promise<string | undefined> {
    try {
      const response = await fetch(`http://127.0.0.1:${this.options.port}/json/list`, {
        signal: AbortSignal.timeout(2_000),
      });
      const pages = (await response.json()) as Array<{
        id?: unknown;
        type?: unknown;
        url?: unknown;
        title?: unknown;
        webSocketDebuggerUrl?: unknown;
      }>;
      if (!Array.isArray(pages)) return undefined;
      const usable = pages.filter(
        (page) =>
          page.type === "page" &&
          typeof page.id === "string" &&
          typeof page.webSocketDebuggerUrl === "string" &&
          !(page.url === "about:blank" && !page.title),
      ) as Array<{ id: string; webSocketDebuggerUrl: string }>;
      if (!botId) return usable.at(-1)?.webSocketDebuggerUrl;
      // The API serves preview and the worker runs the bot, so ownership must come from the
      // shared file as well as this process's maps.
      const owners = await this.readOwners();
      const ownedId =
        this.botTab.get(botId) ??
        [...this.owned.entries()].find(([, bot]) => bot === botId)?.[0] ??
        Object.entries(owners).find(([, bot]) => bot === botId)?.[0];
      // Never borrow another bot's page: a screenshot and the click after it must stay on one tab.
      return usable.find((page) => page.id === ownedId)?.webSocketDebuggerUrl;
    } catch {
      return undefined;
    }
  }

  private sendCdp<T>(url: string, method: string, params: Record<string, unknown>): Promise<T> {
    return this.sendCdpBatch<T>(url, [{ method, params }]);
  }

  /** One socket per batch: a click is press+release, a key is down+up. */
  private sendCdpBatch<T>(
    url: string,
    commands: Array<{ method: string; params: Record<string, unknown> }>,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { maxPayload: 32 * 1024 * 1024 });
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error("The browser did not answer"));
      }, 5_000);
      const lastId = commands.length;
      socket.on("open", () => {
        commands.forEach((command, index) => {
          socket.send(JSON.stringify({ id: index + 1, ...command }));
        });
      });
      socket.on("message", (raw) => {
        let message: { id?: number; result?: unknown; error?: { message?: string } };
        try {
          message = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (message.id !== lastId) return;
        clearTimeout(timer);
        socket.close();
        if (message.error) reject(new Error(message.error.message ?? "The browser refused it"));
        else resolve(message.result as T);
      });
      socket.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  private async tabUrls(): Promise<Map<string, string>> {
    const tabs = await this.listTabs();
    return new Map(tabs.map((tab) => [tab.id, tab.url]));
  }

  /** Ownership is written by the worker and read by the API, so it lives beside the lock. */
  private get ownersFile(): string {
    return path.join(browserStateDir(), `rakazo-browser-${this.options.port}-owners.json`);
  }

  private async readOwners(): Promise<Record<string, string>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.ownersFile, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, string>)
        : {};
    } catch {
      return {};
    }
  }

  private async writeOwners(owners: Record<string, string>): Promise<void> {
    mkdirSync(browserStateDir(), { recursive: true, mode: 0o700 });
    const temp = `${this.ownersFile}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(owners), { mode: 0o600 });
    await rename(temp, this.ownersFile);
  }

  private async rememberOwner(botId: string, before: Map<string, string>) {
    const after = await this.tabUrls();
    const wanted = this.lastResultUrl ?? "";
    const previous = this.botTab.get(botId);
    let target = previous && after.has(previous) ? previous : undefined;
    // A command that leaves the page on the same URL (a snapshot after navigating earlier) names
    // no change, so the answer's URL identifies its tab instead.
    if (!target && wanted) {
      for (const [id, url] of after) {
        if (url === wanted && (!this.owned.has(id) || this.owned.get(id) === botId)) {
          target = id;
          break;
        }
      }
    }
    if (!target) {
      for (const [id, url] of after) {
        if (before.get(id) !== url) {
          target = id;
          break;
        }
      }
    }
    if (target && after.has(target)) {
      this.botTab.set(botId, target);
      this.owned.set(target, botId);
      const owners = await this.readOwners();
      owners[target] = botId;
      await this.writeOwners(owners).catch(() => undefined);
    }
  }

  /** True while the shared Chromium answers on its loopback port. */
  async isRunning(): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${this.options.port}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    return withBrowserLock(browserLockPath(this.options.port), fn);
  }

  private async execute(
    request: PageBrowserCommand,
    home: string,
    signal?: AbortSignal,
  ): Promise<PageBrowserResult> {
    if (!(await this.isRunning())) {
      throw new Error(
        "The shared browser is not running. Start it with scripts/native/browser.sh.",
      );
    }
    if (signal?.aborted) throw new Error("Page browser cancelled");
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.helper, [helperCommand(request.command)], {
        env: browserEnvironment(home, this.options),
        stdio: ["pipe", "pipe", "pipe"],
        // Its own process group, so cancellation reaches agent-browser as well.
        detached: true,
      });
      // The payload never touches argv: element refs, typed text and saved-login origins are
      // readable by any process listing this host's arguments.
      child.stdin.end(`${JSON.stringify(request)}\n`);
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        fn();
      };
      const abort = () =>
        finish(() => {
          killTree(child);
          reject(new Error("Page browser cancelled"));
        });
      const timer = setTimeout(
        () =>
          finish(() => {
            killTree(child);
            reject(new Error("Page browser timed out; the page may be busy or blocked by a dialog."));
          }),
        COMMAND_TIMEOUT_MS,
      );
      signal?.addEventListener("abort", abort, { once: true });
      child.stdin.on("error", () => {
        // The helper exited before reading its request; its exit status says why.
      });
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 16_384) stderr += chunk.toString("utf8");
      });
      child.on("error", (error) =>
        finish(() => reject(new Error(`Page browser unavailable: ${error.message}`))),
      );
      child.on("close", (code) =>
        finish(() => {
          // Exit 2 is the helper refusing the command before touching the page; pass its reply on.
          if (code === 2 && stdout) {
            try {
              const refused = JSON.parse(stdout) as PageBrowserResult;
              this.lastResultUrl = typeof refused.url === "string" ? refused.url : undefined;
              resolve(refused);
              return;
            } catch {
              // Fall through to the failure below.
            }
          }
          if (code !== 0) {
            reject(
              new Error(
                stderr.trim() ||
                  (code === null
                    ? "Page browser unavailable or interrupted"
                    : `Page browser failed: ${code}`),
              ),
            );
            return;
          }
          try {
            const parsed = JSON.parse(stdout) as PageBrowserResult;
            this.lastResultUrl = typeof parsed.url === "string" ? parsed.url : undefined;
            resolve(parsed);
          } catch {
            reject(new Error("Page browser returned an unreadable answer"));
          }
        }),
      );
    });
  }
}
