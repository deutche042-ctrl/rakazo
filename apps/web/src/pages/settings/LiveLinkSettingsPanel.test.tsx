// @vitest-environment jsdom

import { flush } from "@rakazo/core/test-async";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createQueryRoot as createRoot } from "../../lib/query/query-root.test-support";

vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.flatMap((part, index) => [part, values[index] ?? ""]).join("");
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children?: ReactNode }) => children,
  };
});

vi.mock("@rakazo/ui-web", () => ({
  // The real Button turns variant/size into classes; the double drops them so the rest reaches
  // the DOM. They belong to the double's own props, not to a plain <button>'s.
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
}));

import { LiveLinkSettingsPanel } from "./LiveLinkSettingsPanel";

const URL_ = "https://quiet-pine-42.trycloudflare.com";

function view(overrides: Record<string, unknown> = {}) {
  return {
    state: "running",
    url: URL_,
    since: "2026-11-25T10:00:00.000Z",
    pid: 4242,
    lastError: null,
    uptimeSeconds: 90,
    logs: ["INF Registered tunnel connection", "INF GET /app 200"],
    ...overrides,
  };
}

/** A fetch that serves the current view on GET and a stopped one on POST, recording both. */
function stubRuntime(initial: Record<string, unknown>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let current: Record<string, unknown> = { ...initial };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/stop")) {
      current = view({ state: "stopped", url: null, uptimeSeconds: null, lastError: null });
      return Response.json(current);
    }
    return Response.json(current);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

async function renderPanel() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<LiveLinkSettingsPanel />);
    await flush();
  });
  return { container, root };
}

function byTestId(container: HTMLElement, id: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  expect(found, `element ${id}`).toBeTruthy();
  return found!;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

it("shows a green lamp, the link, the uptime, Stop and the last log lines while running", async () => {
  stubRuntime(view());
  const { container, root } = await renderPanel();

  await vi.waitFor(() => expect(container.textContent).toContain("Running"));
  expect(byTestId(container, "live-link-lamp").dataset.state).toBe("running");
  expect(byTestId(container, "live-link-lamp").className).toContain("bg-success");
  expect(container.textContent).toContain(URL_);
  expect(container.textContent).toContain("Up 1m 30s");
  expect(byTestId(container, "live-link-stop")).toBeTruthy();
  expect(byTestId(container, "live-link-copy")).toBeTruthy();
  expect(byTestId(container, "live-link-logs").querySelector("pre")?.textContent).toContain(
    "INF GET /app 200",
  );

  act(() => root.unmount());
});

it("stops the tunnel with a JSON POST and turns the lamp off", async () => {
  const calls = stubRuntime(view());
  const { container, root } = await renderPanel();
  await vi.waitFor(() => expect(container.textContent).toContain("Running"));

  const stop = byTestId(container, "live-link-stop") as HTMLButtonElement;
  await act(async () => {
    stop.click();
    await flush();
  });

  const posted = calls.find(({ url, init }) => url.endsWith("/stop") && init?.method === "POST");
  expect(posted, "POST to the stop route").toBeTruthy();
  expect(new Headers(posted!.init?.headers).get("content-type")).toContain("application/json");
  await vi.waitFor(() => expect(container.textContent).toContain("Stopped"));
  expect(container.querySelector('[data-testid="live-link-stop"]')).toBeNull();
  expect(byTestId(container, "live-link-lamp").className).toContain("bg-destructive");

  act(() => root.unmount());
});

it("shows a red lamp and no Stop when the tunnel is stopped", async () => {
  stubRuntime(view({ state: "stopped", url: null, uptimeSeconds: null, logs: [] }));
  const { container, root } = await renderPanel();

  await vi.waitFor(() => expect(container.textContent).toContain("Stopped"));
  expect(byTestId(container, "live-link-lamp").className).toContain("bg-destructive");
  expect(container.querySelector('[data-testid="live-link-stop"]')).toBeNull();
  expect(container.textContent).toContain("bash scripts/native/tunnel.sh");
  expect(container.textContent).toContain("No log lines yet.");

  act(() => root.unmount());
});

it("shows an orange lamp and the last error when the tunnel has a problem", async () => {
  stubRuntime(
    view({
      state: "error",
      url: null,
      uptimeSeconds: null,
      lastError: "The tunnel process is gone.",
    }),
  );
  const { container, root } = await renderPanel();

  await vi.waitFor(() => expect(container.textContent).toContain("Problem"));
  expect(byTestId(container, "live-link-lamp").dataset.state).toBe("error");
  expect(byTestId(container, "live-link-lamp").className).toContain("bg-warning");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "The tunnel process is gone.",
  );
  expect(container.querySelector('[data-testid="live-link-stop"]')).toBeNull();

  act(() => root.unmount());
});

it("asks for a sign-in instead of an error when the API answers 401", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: "Unauthorized" }, { status: 401 })),
  );
  const { container, root } = await renderPanel();

  await vi.waitFor(() => expect(container.textContent).toContain("Sign in again"));
  const link = [...container.querySelectorAll("a")].find(
    (candidate) => candidate.textContent === "Sign in",
  );
  expect(link?.getAttribute("href")).toBe("/sign-in");
  expect(container.textContent).not.toContain("Could not read");
  expect(container.querySelector('[data-testid="live-link-stop"]')).toBeNull();

  act(() => root.unmount());
});

it("reports a failed read without pretending the tunnel is off", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("connection refused");
    }),
  );
  const { container, root } = await renderPanel();

  await vi.waitFor(() => expect(container.textContent).toContain("Could not read the live link"));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("network");
  expect(container.querySelector('[data-testid="live-link-lamp"]')).toBeNull();

  act(() => root.unmount());
});
