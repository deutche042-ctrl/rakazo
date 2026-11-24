import { anySignal, cancelResponseBody, readBoundedJsonResponse, withAbort } from "@rakazo/core";

/**
 * The native live link (scripts/native/tunnel.sh) as the phone reads it. The API route owns the
 * tunnel's state and the log; this module only reads the state, because the phone shows the link
 * and never starts, stops or logs into the machine it is connected to.
 */

export const LIVE_LINK_PATH = "/api/native/runtime";
/** While the Server screen is open and visible, the state follows the tunnel this often. */
export const LIVE_LINK_REFRESH_MS = 5000;
export const LIVE_LINK_TIMEOUT_MS = 8000;
/** A state reply is a few hundred bytes; the cap refuses anything pretending to be one. */
export const LIVE_LINK_MAX_BYTES = 64 * 1024;

export type LiveLinkState = "running" | "stopped" | "error" | "off";
export type LiveLinkTone = "success" | "warning" | "destructive";

export interface LiveLinkView {
  state: LiveLinkState;
  /** The public https link, while the tunnel runs. */
  url: string | null;
  /** When the tunnel started, as an ISO timestamp. */
  since: string | null;
  /** Whole seconds since `since`; null unless the tunnel is running. */
  uptimeSeconds: number | null;
  lastError: string | null;
}

export interface LiveLinkTarget {
  /** The server origin, for example https://app.example.com. */
  base: string;
  /** The session and per-server headers, as the rest of the app sends them. */
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  /** React Query's signal, so a read stops when the screen leaves. */
  signal?: AbortSignal;
}

const STATES: ReadonlySet<string> = new Set(["running", "stopped", "error", "off"]);

export function liveLinkTone(state: LiveLinkState): LiveLinkTone {
  if (state === "running") return "success";
  if (state === "error") return "warning";
  return "destructive";
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Anything the script could not have written is refused, never shown as a running tunnel. */
export function parseLiveLink(raw: unknown): LiveLinkView | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.state !== "string" || !STATES.has(record.state)) return null;
  const uptime = record.uptimeSeconds;
  return {
    state: record.state as LiveLinkState,
    url: text(record.url),
    since: text(record.since),
    uptimeSeconds:
      typeof uptime === "number" && Number.isFinite(uptime) && uptime >= 0
        ? Math.round(uptime)
        : null,
    lastError: text(record.lastError),
  };
}

/**
 * One read of the runtime route. Null is "this phone cannot show a live link here": no session,
 * no route, an unreachable server or a reply that is not a state. The Server screen hides the
 * group rather than offering a link nobody can use.
 */
export async function readLiveLink(target: LiveLinkTarget): Promise<LiveLinkView | null> {
  const url = `${target.base.replace(/\/+$/, "")}${LIVE_LINK_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Request timed out")),
    LIVE_LINK_TIMEOUT_MS,
  );
  const signal = target.signal ? anySignal([target.signal, controller.signal]) : controller.signal;
  try {
    const response = await withAbort(
      (target.fetchImpl ?? fetch)(url, {
        method: "GET",
        headers: { accept: "application/json", origin: "rakazo://", ...target.headers },
        // Bearer only: this server's cookie must not reach whatever else shares the jar.
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal,
      }),
      signal,
      "Request timed out",
    );
    // A signed-out caller and a server without the route both mean the same thing here.
    if (!response.ok) {
      cancelResponseBody(response);
      return null;
    }
    return parseLiveLink(
      await readBoundedJsonResponse<unknown>(response, LIVE_LINK_MAX_BYTES, signal),
    );
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The host part of the link, which the row shows where the full URL does not fit. */
export function liveLinkHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** `1d 2h`, `3h 4m`, `5m 6s`, `7s`: whole units, two at most. */
export function formatUptime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${rest}s`;
  return `${rest}s`;
}
