import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { browserLockPath, nativeBrowserOptions, withBrowserLock } from "./native-browser.js";

let directory: string | undefined;

async function lockPath() {
  directory = await mkdtemp(path.join(tmpdir(), "rakazo-lock-test-"));
  return path.join(directory, "browser.lock");
}

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("nativeBrowserOptions", () => {
  it("stays off unless asked for, and needs every path", () => {
    expect(nativeBrowserOptions({})).toBeUndefined();
    expect(nativeBrowserOptions({ RAKAZO_NATIVE_BROWSER: "1" })).toBeUndefined();
    expect(
      nativeBrowserOptions({
        RAKAZO_NATIVE_BROWSER: "1",
        RAKAZO_NATIVE_PAGE_BROWSER: "/helper",
        RAKAZO_AGENT_BROWSER: "/agent-browser",
      }),
    ).toEqual({ port: 9222, helper: "/helper", agentBrowser: "/agent-browser" });
  });

  it("rejects a port that is not a loopback TCP port number", () => {
    const base = {
      RAKAZO_NATIVE_BROWSER: "1",
      RAKAZO_NATIVE_PAGE_BROWSER: "/helper",
      RAKAZO_AGENT_BROWSER: "/agent-browser",
    };
    expect(nativeBrowserOptions({ ...base, RAKAZO_NATIVE_BROWSER_PORT: "0" })).toBeUndefined();
    expect(nativeBrowserOptions({ ...base, RAKAZO_NATIVE_BROWSER_PORT: "99999" })).toBeUndefined();
    expect(
      nativeBrowserOptions({ ...base, RAKAZO_NATIVE_BROWSER_PORT: "9333" })?.port,
    ).toBe(9333);
  });
});

describe("withBrowserLock", () => {
  it("serializes callers, which the in-process queue alone cannot do", async () => {
    const lock = await lockPath();
    let active = 0;
    let peak = 0;
    const task = () =>
      withBrowserLock(lock, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
      });
    await Promise.all([task(), task(), task()]);
    expect(peak).toBe(1);
  });

  it("removes a lock left behind by a dead process", async () => {
    const lock = await lockPath();
    await writeFile(lock, "stale");
    const long_ago = new Date(Date.now() - 120_000);
    await utimes(lock, long_ago, long_ago);
    await expect(withBrowserLock(lock, async () => "ran")).resolves.toBe("ran");
  });

  it("releases the lock when the work throws", async () => {
    const lock = await lockPath();
    await expect(
      withBrowserLock(lock, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(withBrowserLock(lock, async () => "next")).resolves.toBe("next");
  });

  it("names one lock per CDP port", () => {
    expect(browserLockPath(9222)).toContain("rakazo-browser-9222.lock");
    expect(browserLockPath(9222)).not.toBe(browserLockPath(9223));
  });
});
