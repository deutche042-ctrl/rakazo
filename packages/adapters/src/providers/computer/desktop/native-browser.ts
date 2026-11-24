import { spawn } from "node:child_process";
import type { PageBrowserCommand, PageBrowserResult } from "@rakazo/adapter-kit";

/** The supervisor's own limits, so a native page browser answers like the in-container one. */
const MAX_OUTPUT_BYTES = 512 * 1024;
const COMMAND_TIMEOUT_MS = 25_000;

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

export class NativeBrowser {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: NativeBrowserOptions) {}

  /**
   * One browser serves every bot, so its commands run one at a time. The helper's session is bound
   * to the display, and two commands naming element refs at once would read each other's page.
   */
  run(
    request: PageBrowserCommand,
    home: string,
    signal?: AbortSignal,
  ): Promise<PageBrowserResult> {
    const next = this.tail.then(
      () => this.execute(request, home, signal),
      () => this.execute(request, home, signal),
    );
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
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
          child.kill("SIGKILL");
          reject(new Error("Page browser cancelled"));
        });
      const timer = setTimeout(
        () =>
          finish(() => {
            child.kill("SIGKILL");
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
              resolve(JSON.parse(stdout) as PageBrowserResult);
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
            resolve(JSON.parse(stdout) as PageBrowserResult);
          } catch {
            reject(new Error("Page browser returned an unreadable answer"));
          }
        }),
      );
    });
  }
}
