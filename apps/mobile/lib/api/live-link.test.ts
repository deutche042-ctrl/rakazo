import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatUptime,
  LIVE_LINK_MAX_BYTES,
  LIVE_LINK_PATH,
  liveLinkHost,
  liveLinkTone,
  parseLiveLink,
  readLiveLink,
} from "./live-link.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const RUNNING = {
  state: "running",
  url: "https://quiet-forest.trycloudflare.com",
  since: "2026-11-25T09:00:00.000Z",
  pid: 4242,
  lastError: null,
  uptimeSeconds: 95,
  logs: ["line one", "line two"],
};

describe("parseLiveLink", () => {
  it("keeps the state, link, uptime and error and drops the log", () => {
    expect(parseLiveLink(RUNNING)).toEqual({
      state: "running",
      url: "https://quiet-forest.trycloudflare.com",
      since: "2026-11-25T09:00:00.000Z",
      uptimeSeconds: 95,
      lastError: null,
    });
    const view = parseLiveLink(RUNNING);
    expect(view).not.toHaveProperty("logs");
  });

  it("refuses a state it cannot show, and non-object replies", () => {
    expect(parseLiveLink({ state: "live" })).toBeNull();
    expect(parseLiveLink(null)).toBeNull();
    expect(parseLiveLink("running")).toBeNull();
    expect(parseLiveLink({ state: "running", uptimeSeconds: -1 })).toMatchObject({
      uptimeSeconds: null,
    });
    expect(parseLiveLink({ state: "error", lastError: " " })).toMatchObject({ lastError: null });
  });
});

describe("readLiveLink", () => {
  it("reads the runtime route with the session and per-server headers", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(RUNNING));
    vi.stubGlobal("fetch", fetchMock);

    const view = await readLiveLink({
      base: "https://phone.example.com/",
      headers: { authorization: "Bearer token", "x-rakazo-space-id": "space-1" },
    });

    expect(view).toMatchObject({ state: "running", uptimeSeconds: 95 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://phone.example.com${LIVE_LINK_PATH}`);
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
    const headers = new Headers(init.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("authorization")).toBe("Bearer token");
    expect(headers.get("x-rakazo-space-id")).toBe("space-1");
  });

  it("hides the panel when the route is missing or the session is gone", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(readLiveLink({ base: "https://phone.example.com" })).resolves.toBeNull();
    await expect(readLiveLink({ base: "https://phone.example.com" })).resolves.toBeNull();
  });

  it("hides the panel for a reply that is not JSON, not a state, or too large", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("<html>sign in</html>", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ state: "live" }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ state: "running", url: "x".repeat(LIVE_LINK_MAX_BYTES) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(readLiveLink({ base: "https://phone.example.com" })).resolves.toBeNull();
    await expect(readLiveLink({ base: "https://phone.example.com" })).resolves.toBeNull();
    await expect(readLiveLink({ base: "https://phone.example.com" })).resolves.toBeNull();
  });

  it("hides the panel when the server cannot be reached", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("Network request failed");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(readLiveLink({ base: "https://phone.example.com" })).resolves.toBeNull();
  });
});

describe("the row copies the web panel's meaning", () => {
  it("turns a state into the same lamp tone", () => {
    expect(liveLinkTone("running")).toBe("success");
    expect(liveLinkTone("error")).toBe("warning");
    expect(liveLinkTone("stopped")).toBe("destructive");
    expect(liveLinkTone("off")).toBe("destructive");
  });

  it("names the host of the link, or nothing when it is not a URL", () => {
    expect(liveLinkHost("https://quiet-forest.trycloudflare.com")).toBe(
      "quiet-forest.trycloudflare.com",
    );
    expect(liveLinkHost("not a link")).toBeNull();
    expect(liveLinkHost(null)).toBeNull();
  });

  it("formats the uptime in at most two units", () => {
    expect(formatUptime(7)).toBe("7s");
    expect(formatUptime(95)).toBe("1m 35s");
    expect(formatUptime(3 * 3600 + 4 * 60)).toBe("3h 4m");
    expect(formatUptime(86400 + 2 * 3600)).toBe("1d 2h");
  });
});
