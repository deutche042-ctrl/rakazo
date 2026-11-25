import type { Auth } from "@rakazo/auth";
import { Hono } from "hono";
import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../env.js";
import { mountAuthCapabilities } from "./auth-capabilities.js";

const baseEnv = {
  passwordAuth: true,
  webOrigin: "http://localhost:5173",
  passkeyAppleAppIds: [],
  passkeyAndroidCertFingerprints: [],
} as unknown as AppEnv;

/** Mounts the route over a fake auth library, so no database or session is involved. */
function mount(
  registrationOpen: (headers: Headers) => boolean,
  desktopStackToken?: string,
): { app: Hono; policy: Mock<(headers: Headers) => boolean> } {
  const app: Hono = new Hono();
  const policy = vi.fn(registrationOpen);
  const auth = {
    registrationOpen: policy,
    ssoAvailability: () => null,
    emailCodeSignIn: false,
    passkeyRpId: "localhost",
  } as unknown as Auth;
  mountAuthCapabilities(app, {
    env: { ...baseEnv, desktopStackToken } as AppEnv,
    auth,
    email: undefined,
    billing: undefined,
  });
  return { app, policy };
}

describe("GET /api/auth/capabilities", () => {
  it("reports signup as open when the deployment allows it, with no desktop token", async () => {
    const { app } = mount(() => true);
    const response = await app.request("/api/auth/capabilities");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ registrationOpen: true });
  });

  it("reports signup as closed when the signup policy closes it", async () => {
    const { app } = mount(() => false);
    const response = await app.request("/api/auth/capabilities");
    await expect(response.json()).resolves.toMatchObject({ registrationOpen: false });
  });

  it("passes the request headers to the policy when a desktop stack token is set", async () => {
    const { app, policy } = mount(
      (headers) => headers.get("x-rakazo-desktop-stack-token") === "token-abc",
      "token-abc",
    );
    const response = await app.request("/api/auth/capabilities", {
      headers: { "x-rakazo-desktop-stack-token": "token-abc" },
    });
    await expect(response.json()).resolves.toMatchObject({ registrationOpen: true });
    const headers = policy.mock.calls[0]?.[0];
    expect(headers?.get("x-rakazo-desktop-stack-token")).toBe("token-abc");
  });
});
