import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API_PROBE_TIMEOUT_MS,
  apiBaseWarning,
  defaultApiBase,
  displayApiHost,
  displaySavedServer,
  MAX_API_PROBE_RESPONSE_BYTES,
  normalizeApiBase,
  probeApiBase,
  usesCustomApiBase,
} from "./endpoint.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("normalizeApiBase", () => {
  it("trims, adds https, and keeps only the origin", () => {
    expect(normalizeApiBase("  app.example.com/rpc  ")).toEqual({
      ok: true,
      url: "https://app.example.com",
    });
    expect(normalizeApiBase("https://rakazo.example.com:8443/api/")).toEqual({
      ok: true,
      url: "https://rakazo.example.com:8443",
    });
    expect(normalizeApiBase("http://192.168.1.20:3100/")).toEqual({
      ok: true,
      url: "http://192.168.1.20:3100",
    });
    expect(normalizeApiBase("http://app.example.com")).toEqual({
      ok: false,
      error: "Public servers need https://. HTTP only works on your local network.",
    });
  });

  it("keeps plain http for a typed local host and uses https everywhere else", () => {
    expect(normalizeApiBase("192.168.1.10:3100")).toEqual({
      ok: true,
      url: "http://192.168.1.10:3100",
    });
    expect(normalizeApiBase("127.0.0.1:3100")).toEqual({ ok: true, url: "http://127.0.0.1:3100" });
    expect(normalizeApiBase("localhost:3100")).toEqual({ ok: true, url: "http://localhost:3100" });
    expect(normalizeApiBase("10.0.0.8")).toEqual({ ok: true, url: "http://10.0.0.8" });
    expect(normalizeApiBase("app.example.com")).toEqual({
      ok: true,
      url: "https://app.example.com",
    });
    // Link-local is not this network, so a typed metadata address does not become plain http.
    expect(normalizeApiBase("169.254.169.254:80")).toEqual({
      ok: true,
      url: "https://169.254.169.254:80",
    });
  });

  it("accepts a live tunnel link pasted as-is and keeps it on https", () => {
    expect(normalizeApiBase("  https://quiet-river-1234.trycloudflare.com/  ")).toEqual({
      ok: true,
      url: "https://quiet-river-1234.trycloudflare.com",
    });
    // The link is often copied without its scheme; a public tunnel host still gets https.
    expect(normalizeApiBase("quiet-river-1234.trycloudflare.com")).toEqual({
      ok: true,
      url: "https://quiet-river-1234.trycloudflare.com",
    });
    expect(normalizeApiBase("https://quiet-river-1234.trycloudflare.com/rpc/health")).toEqual({
      ok: true,
      url: "https://quiet-river-1234.trycloudflare.com",
    });
    // An explicit https origin is never downgraded, even when the host looks local.
    expect(normalizeApiBase("https://localhost:3100")).toEqual({
      ok: true,
      url: "https://localhost:3100",
    });
  });

  it("rejects empty, non-http, and malformed values", () => {
    expect(normalizeApiBase("")).toMatchObject({ ok: false });
    expect(normalizeApiBase("   ")).toMatchObject({ ok: false });
    expect(normalizeApiBase("javascript:alert(1)")).toMatchObject({ ok: false });
    expect(normalizeApiBase("ftp://files.example.com")).toMatchObject({ ok: false });
    expect(normalizeApiBase("http://")).toMatchObject({ ok: false });
  });

  it("strips credentials from the stored origin", () => {
    expect(normalizeApiBase("https://user:pass@app.example.com/rpc")).toEqual({
      ok: true,
      url: "https://app.example.com",
    });
  });
});

describe("display and warnings", () => {
  it("falls back to loopback when the compile-time endpoint is invalid", async () => {
    vi.stubEnv("EXPO_PUBLIC_API_URL", "ftp://files.example.com");
    vi.resetModules();
    const endpoint = await import("./endpoint.js");

    expect(endpoint.defaultApiBase()).toBe("http://127.0.0.1:3100");
    vi.unstubAllEnvs();
  });

  it("falls back to loopback when the compile-time endpoint is public HTTP", async () => {
    vi.stubEnv("EXPO_PUBLIC_API_URL", "http://app.example.com");
    vi.resetModules();
    const endpoint = await import("./endpoint.js");

    expect(endpoint.defaultApiBase()).toBe("http://127.0.0.1:3100");
    vi.unstubAllEnvs();
  });

  it("shows host and non-default port", () => {
    expect(displayApiHost("https://rakazo.example.com")).toBe("rakazo.example.com");
    expect(displayApiHost("http://10.0.0.8:3100")).toBe("10.0.0.8:3100");
  });

  it("keeps http visible on a saved server so it differs from its https twin", () => {
    expect(displaySavedServer("https://10.0.0.8")).toBe("10.0.0.8");
    expect(displaySavedServer("http://10.0.0.8")).toBe("http://10.0.0.8");
    expect(displaySavedServer("http://10.0.0.8:3100")).toBe("http://10.0.0.8:3100");
  });

  it("warns on public http but not LAN or loopback", () => {
    expect(apiBaseWarning("https://app.example.com")).toBeNull();
    expect(apiBaseWarning("http://127.0.0.1:3100")).toBeNull();
    expect(apiBaseWarning("http://192.168.1.20:3100")).toBeNull();
    expect(apiBaseWarning("http://100.64.0.1:3100")).toBeNull();
    expect(apiBaseWarning("http://100.119.57.55:3100")).toBeNull();
    expect(apiBaseWarning("http://100.127.255.255:3100")).toBeNull();
    expect(apiBaseWarning("http://app.example.com")).toMatch(/https/i);
  });

  it("shares the desktop private-network rules for cleartext servers", () => {
    expect(apiBaseWarning("http://127.0.0.2:3100")).toBeNull();
    expect(apiBaseWarning("http://[fd00::1]:3100")).toBeNull();
    expect(apiBaseWarning("http://rakazo.localhost:3100")).toBeNull();
    expect(apiBaseWarning("http://169.254.169.254")).toMatch(/https/i);
    expect(apiBaseWarning("http://100.100.100.200")).toMatch(/https/i);
    expect(apiBaseWarning("http://[fe80::1]:3100")).toMatch(/https/i);
  });

  it("treats the compile-time default as not custom", () => {
    expect(usesCustomApiBase(defaultApiBase())).toBe(false);
    expect(usesCustomApiBase("https://rakazo.example.com")).toBe(true);
  });
});

describe("probeApiBase", () => {
  it("accepts a Rakazo /rpc/health response", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ json: { ok: true, version: "0.1.0" } }), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(probeApiBase("https://app.example.com", fetchImpl)).resolves.toEqual({
      ok: true,
      url: "https://app.example.com",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://app.example.com/rpc/health",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects a host that is up but is not Rakazo", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(probeApiBase("https://example.com", fetchImpl)).resolves.toMatchObject({
      ok: false,
    });
  });

  it("names a tunnel that refuses the request before Rakazo answers", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 403 }),
    ) as unknown as typeof fetch;

    await expect(probeApiBase("https://quiet-river.trycloudflare.com", fetchImpl)).resolves.toEqual(
      {
        ok: false,
        reason: "refused",
        error: "The server refused the request. Check its access headers and that it is running.",
      },
    );
  });

  it("rejects an oversized health response", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ json: { ok: true } }), {
          headers: { "content-length": String(MAX_API_PROBE_RESPONSE_BYTES + 1) },
        }),
    ) as unknown as typeof fetch;

    await expect(probeApiBase("https://app.example.com", fetchImpl)).resolves.toEqual({
      ok: false,
      reason: "not-rakazo",
      error: "That URL did not look like a Rakazo server",
    });
  });

  it("returns a failure when an injected fetch ignores the probe signal", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(() => undefined),
    );

    const pending = probeApiBase("https://app.example.com", fetchImpl as typeof fetch);
    await vi.advanceTimersByTimeAsync(API_PROBE_TIMEOUT_MS);

    await expect(pending).resolves.toEqual({
      ok: false,
      reason: "timeout",
      error: "The server did not answer in time. Check it is running, then try again.",
    });
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("returns a failure when a health response body never settles", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({ cancel })));

    const pending = probeApiBase("https://app.example.com", fetchImpl as typeof fetch);
    await vi.advanceTimersByTimeAsync(API_PROBE_TIMEOUT_MS);

    await expect(pending).resolves.toEqual({
      ok: false,
      reason: "timeout",
      error: "The server did not answer in time. Check it is running, then try again.",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("names a certificate the phone will not trust", async () => {
    const fetchImpl = rejectedFetch(
      Object.assign(new TypeError("Network request failed"), {
        cause: new Error("The certificate for this server is invalid."),
      }),
    );

    await expect(probeApiBase("https://quiet-river.trycloudflare.com", fetchImpl)).resolves.toEqual(
      {
        ok: false,
        reason: "certificate",
        error: "The server’s certificate could not be verified. Check the address, then try again.",
      },
    );
  });

  it("names a tunnel host the phone cannot resolve", async () => {
    const fetchImpl = rejectedFetch(
      Object.assign(new TypeError("Network request failed"), {
        cause: new Error("getaddrinfo ENOTFOUND quiet-river.trycloudflare.com"),
      }),
    );

    await expect(probeApiBase("https://quiet-river.trycloudflare.com", fetchImpl)).resolves.toEqual(
      {
        ok: false,
        reason: "dns",
        error: "That address could not be found. Check it and try again.",
      },
    );
  });

  it("names a refused local server", async () => {
    const fetchImpl = rejectedFetch(new Error("connect ECONNREFUSED 192.168.1.10:3100"));

    await expect(probeApiBase("http://192.168.1.10:3100", fetchImpl)).resolves.toEqual({
      ok: false,
      reason: "refused",
      error: "The server refused the connection. Check it is running and the address is right.",
    });
  });

  it("falls back to an unreachable message with no cause detail", async () => {
    const fetchImpl = rejectedFetch(new TypeError("Network request failed"));

    await expect(probeApiBase("https://quiet-river.trycloudflare.com", fetchImpl)).resolves.toEqual(
      {
        ok: false,
        reason: "unreachable",
        error: "Could not reach that server",
      },
    );
  });
});

function rejectedFetch(error: unknown): typeof fetch {
  return vi.fn(async () => {
    throw error;
  }) as unknown as typeof fetch;
}
