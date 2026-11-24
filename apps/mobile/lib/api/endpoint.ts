import { t } from "@lingui/core/macro";
import { isPrivateNetworkHost } from "@rakazo/contracts";
import {
  cancelResponseBody,
  ResponseBodyTooLargeError,
  readBoundedJsonResponse,
  withAbort,
} from "@rakazo/core";
import { DEFAULT_API, LOCAL_API } from "./server-config";

export const API_PROBE_TIMEOUT_MS = 8_000;
export const MAX_API_PROBE_RESPONSE_BYTES = 64 * 1024;

/** Why a server could not be used, so the screen can name the cause instead of "failed". */
export type EndpointFailure =
  | "timeout"
  | "certificate"
  | "dns"
  | "refused"
  | "unreachable"
  | "not-rakazo";

export type EndpointResult =
  | { ok: true; url: string }
  | { ok: false; error: string; reason?: EndpointFailure };
type HealthResponse = { json?: { ok?: boolean }; error?: { message?: string } };

export function defaultApiBase() {
  return originOnly(DEFAULT_API) ?? LOCAL_API;
}

export function normalizeApiBase(input: string): EndpointResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: t`Enter a server URL` };
  let parsed: URL;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
      parsed = new URL(trimmed);
    } else {
      // A typed host gets https unless it is on this network, where the dev server is plain http.
      const candidate = new URL(`http://${trimmed}`);
      parsed = isPrivateNetworkHost(candidate.hostname) ? candidate : new URL(`https://${trimmed}`);
    }
  } catch {
    return { ok: false, error: t`That doesn’t look like a URL` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: t`Use an http or https URL` };
  }
  if (!parsed.hostname) return { ok: false, error: t`That URL is missing a host` };
  if (parsed.protocol === "http:" && !isPrivateNetworkHost(parsed.hostname)) {
    return { ok: false, error: publicHttpMessage() };
  }
  const url = `${parsed.protocol}//${parsed.host}`;
  return { ok: true, url };
}

export function displayApiHost(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.host;
  } catch {
    return url;
  }
}

/** The host, with `http://` kept so a plain-http server never reads like its https twin. */
export function displaySavedServer(url: string) {
  return url.startsWith("http://") ? url : displayApiHost(url);
}

export function usesCustomApiBase(url: string, fallback = defaultApiBase()) {
  return url !== fallback;
}

export function apiBaseWarning(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" && !isPrivateNetworkHost(parsed.hostname)) {
      return publicHttpMessage();
    }
  } catch {
    return null;
  }
  return null;
}

function publicHttpMessage() {
  return t`Public servers need https://. HTTP only works on your local network.`;
}

export async function probeApiBase(
  input: string,
  fetchImpl: typeof fetch = fetch,
  headers: Record<string, string> = {},
): Promise<EndpointResult> {
  const parsed = normalizeApiBase(input);
  if (!parsed.ok) return parsed;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_PROBE_TIMEOUT_MS);
  try {
    const res = await withAbort(
      fetchImpl(`${parsed.url}/rpc/health`, {
        method: "POST",
        ...(Object.keys(headers).length ? { redirect: "error" as const } : {}),
        headers: { ...headers, "content-type": "application/json", origin: "rakazo://" },
        body: JSON.stringify({ json: {} }),
        signal: controller.signal,
      }),
      controller.signal,
      "Request timed out",
    );
    if (!res.ok) {
      cancelResponseBody(res);
      // A tunnel in front of the server can answer for it: 401/403/407 is access, not the wrong URL.
      if (res.status === 401 || res.status === 403 || res.status === 407) {
        return {
          ok: false,
          reason: "refused",
          error: t`The server refused the request. Check its access headers and that it is running.`,
        };
      }
      return notRakazo();
    }
    let body: HealthResponse;
    try {
      body = await readBoundedJsonResponse<HealthResponse>(
        res,
        MAX_API_PROBE_RESPONSE_BYTES,
        controller.signal,
      );
    } catch (error) {
      if (error instanceof ResponseBodyTooLargeError) return notRakazo();
      if (!(error instanceof SyntaxError)) throw error;
      body = {};
    }
    if (body.error || body.json?.ok !== true) return notRakazo();
    return parsed;
  } catch (error) {
    return probeFailure(error, controller.signal.aborted);
  } finally {
    clearTimeout(timer);
  }
}

function notRakazo(): EndpointResult {
  return {
    ok: false,
    reason: "not-rakazo",
    error: t`That URL did not look like a Rakazo server`,
  };
}

/**
 * A reachable host can still fail before any response arrives: a wrong tunnel, a blocked network,
 * or a certificate the phone will not trust. The messages name the cause so the screen can offer a
 * retry that makes sense, rather than one generic "failed".
 */
function probeFailure(error: unknown, timedOut: boolean): EndpointResult {
  const text = detail(error);
  const reason: EndpointFailure = timedOut
    ? "timeout"
    : /certificate|certpath|ssl|tls|handshake|trust anchor/i.test(text)
      ? "certificate"
      : /enotfound|eai_again|getaddrinfo|nodename nor servname|name or service not known|no such host/i.test(
            text,
          )
        ? "dns"
        : /econnrefused|connection refused|refused to connect/i.test(text)
          ? "refused"
          : "unreachable";
  return { ok: false, reason, error: failureMessage(reason) };
}

function failureMessage(reason: EndpointFailure): string {
  switch (reason) {
    case "timeout":
      return t`The server did not answer in time. Check it is running, then try again.`;
    case "certificate":
      return t`The server’s certificate could not be verified. Check the address, then try again.`;
    case "dns":
      return t`That address could not be found. Check it and try again.`;
    case "refused":
      return t`The server refused the connection. Check it is running and the address is right.`;
    case "not-rakazo":
      return t`That URL did not look like a Rakazo server`;
    default:
      return t`Could not reach that server`;
  }
}

function detail(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // Fetch implementations that keep the network error in `cause` still name the cause here.
  const cause = (error as { cause?: unknown }).cause;
  return `${error.name} ${error.message}${
    cause instanceof Error ? ` ${cause.name} ${cause.message}` : ""
  }`;
}

function originOnly(value: string) {
  const parsed = normalizeApiBase(value);
  return parsed.ok ? parsed.url : null;
}
