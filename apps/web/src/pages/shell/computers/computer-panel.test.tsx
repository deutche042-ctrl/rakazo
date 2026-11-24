// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { Bot, ComputerStatus } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// The live frame reads its picture and sends input through these hooks; a test can point the
// preview at an image and then read the inputs the frame sent.
const frameState = vi.hoisted(() => ({ previewImage: null as string | null }));
const frameMocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  reset: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  BotAvatar: () => null,
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
}));
vi.mock("../../../components/computers/ComputersUnavailableHint", () => ({
  ComputersUnavailableHint: () => null,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { image: frameState.previewImage } }),
  useMutation: () => ({
    mutate: frameMocks.mutate,
    reset: frameMocks.reset,
    isPending: false,
  }),
  useQueryClient: () => ({ invalidateQueries: frameMocks.invalidateQueries }),
}));
vi.mock("../../../lib/query/query", () => ({
  useSpaceQueries: () => ({
    computer: {
      preview: {
        queryOptions: () => ({
          queryKey: ["computer", "preview"],
          queryFn: async () => ({ image: frameState.previewImage }),
        }),
        queryKey: () => ["computer", "preview"],
      },
      input: { mutationOptions: () => ({}) },
    },
  }),
}));

import { ComputerPanel } from "./computer-panel";

let container: HTMLDivElement;
let root: Root;

const bot = { id: "bot-1", name: "Ada" } as Bot;

function computer(state: ComputerStatus["state"]): ComputerStatus {
  return {
    botId: "bot-1",
    mode: "team",
    kind: "boat",
    state,
    controlHolder: "none",
    controlBotId: null,
    takeoverRequested: false,
    screenAvailable: state === "running",
    screenWidth: 1280,
    screenHeight: 800,
    homeRevision: null,
    busyBotName: null,
    canUpdate: false,
    terminalAvailable: false,
  };
}

async function render(
  status: ComputerStatus | null,
  onOpen = vi.fn(),
  disk?: { cleaningUpDisk?: boolean; onCleanUpDisk: () => void; onDismissDiskWarning: () => void },
  embeddedScreenUrl: string | null = null,
  control: { hasControl?: boolean } = {},
) {
  await act(async () => {
    root.render(
      <ComputerPanel
        bot={bot}
        computer={status}
        computerOpen={false}
        embeddedScreenUrl={embeddedScreenUrl}
        screenFrameRef={() => undefined}
        computerScreenError={null}
        computerBooting={null}
        booting={false}
        showingRecoveryHint={false}
        showComputerRecoveryHint={false}
        onRecovered={() => undefined}
        onRecoveryDismissed={() => undefined}
        onOpen={onOpen}
        {...disk}
        {...control}
      />,
    );
  });
  return onOpen;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  frameState.previewImage = null;
  frameMocks.mutate.mockClear();
  frameMocks.reset.mockClear();
  frameMocks.invalidateQueries.mockClear();
  i18n.load("en", {});
  i18n.activate("en");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.each([null, computer("stopped"), computer("suspended")])(
  "shows an idle computer asleep until its Wake button is pressed",
  async (status) => {
    const onOpen = await render(status);
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector('[data-state="idle"]')?.textContent).toContain("Asleep");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="computer-preview-open"]')?.click(),
    );
    expect(onOpen).toHaveBeenCalledOnce();
  },
);

it("shows a running computer's live screen with an Open button", async () => {
  const onOpen = await render(
    computer("running"),
    vi.fn(),
    undefined,
    "https://screen.example.test/",
  );
  expect(container.querySelector('[data-state="running"] iframe')?.getAttribute("src")).toBe(
    "https://screen.example.test/",
  );
  expect(container.querySelector("iframe")?.tabIndex).toBe(-1);
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="computer-preview-open"]')?.click(),
  );
  expect(onOpen).toHaveBeenCalledOnce();
});

it("shows the person's own machine from what the server says", async () => {
  await render({ ...computer("running"), kind: "desktop", runsOnUserMachine: false });
  expect(container.querySelector('[data-state="running"]')).not.toBeNull();
  await render({ ...computer("running"), kind: "any-kind", runsOnUserMachine: true });
  expect(container.querySelector('[data-state="running"]')).toBeNull();
  expect(container.textContent).toContain("This bot runs on your computer");
  await render({ ...computer("stopped"), kind: "any-kind", runsOnUserMachine: true });
  expect(container.querySelector('[data-state="idle"]')).toBeNull();
});

it("still shows the person's own machine when an older server names it only by kind", async () => {
  await render({ ...computer("running"), kind: "desktop" });
  expect(container.querySelector('[data-state="running"]')).toBeNull();
  expect(container.textContent).toContain("Waiting for the browser");
});

it("shows a computer of a kind this build does not know like any other", async () => {
  await render({ ...computer("stopped"), kind: "a-provider-since-removed" });
  expect(container.querySelector('[data-state="idle"]')?.textContent).toContain("Asleep");
  await render({ ...computer("running"), kind: "a-provider-since-removed" });
  expect(container.querySelector('[data-state="running"]')?.textContent).toContain(
    "Connecting to the screen…",
  );
});

it.each([computer("running"), computer("suspended")])(
  "warns that the disk is nearly full and offers a clean up",
  async (status) => {
    const disk = { onCleanUpDisk: vi.fn(), onDismissDiskWarning: vi.fn() };
    await render({ ...status, diskFullPercent: 93 }, vi.fn(), disk);
    const warning = container.querySelector('[data-testid="computer-disk-warning"]');
    expect(warning?.textContent).toContain("Clean up");
    const [cleanUp, dismiss] = warning?.querySelectorAll("button") ?? [];
    await act(async () => cleanUp?.click());
    await act(async () => dismiss?.click());
    expect(disk.onCleanUpDisk).toHaveBeenCalledOnce();
    expect(disk.onDismissDiskWarning).toHaveBeenCalledOnce();
  },
);

it("holds Clean up while a clean up is being sent", async () => {
  const disk = { cleaningUpDisk: true, onCleanUpDisk: vi.fn(), onDismissDiskWarning: vi.fn() };
  await render({ ...computer("running"), diskFullPercent: 93 }, vi.fn(), disk);
  const [cleanUp] =
    container.querySelector('[data-testid="computer-disk-warning"]')?.querySelectorAll("button") ??
    [];
  expect(cleanUp?.hasAttribute("disabled")).toBe(true);
});

it("shows no disk warning while the disk has room", async () => {
  await render(computer("running"), vi.fn(), {
    onCleanUpDisk: vi.fn(),
    onDismissDiskWarning: vi.fn(),
  });
  expect(container.querySelector('[data-testid="computer-disk-warning"]')).toBeNull();
});

it("lists the shared browser's tabs with the bot that opened each", async () => {
  await render({
    ...computer("running"),
    kind: "desktop",
    runsOnUserMachine: true,
    browserAvailable: true,
    browserTabs: [
      {
        id: "tab-1",
        title: "Inbox",
        url: "https://mail.example.com/",
        botId: "bot-2",
        botName: "Grace",
      },
    ],
  });
  expect(container.querySelector('[data-testid="browser-tabs"]')).not.toBeNull();
  expect(container.textContent).toContain("Grace");
  expect(container.textContent).toContain("Inbox");
  expect(container.textContent).toContain("mail.example.com");
});

it("says the bots share a browser before any tab opens", async () => {
  await render({
    ...computer("running"),
    kind: "desktop",
    runsOnUserMachine: true,
    browserAvailable: true,
  });
  expect(container.textContent).toContain("Waiting for the browser");
  expect(container.textContent).not.toContain("Linux desktop");
});

const PREVIEW_IMAGE = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

/** A running desktop computer whose live frame can be driven from the panel. */
function liveComputer(): ComputerStatus {
  return { ...computer("running"), kind: "desktop", runsOnUserMachine: true };
}

async function renderLive(control: { hasControl?: boolean } = { hasControl: true }) {
  frameState.previewImage = PREVIEW_IMAGE;
  await render(liveComputer(), vi.fn(), undefined, null, control);
}

function liveSurface() {
  const surface = container.querySelector<HTMLDivElement>('[data-testid="computer-live-frame"]');
  if (!surface) throw new Error("the live frame is not on screen");
  // jsdom has no pointer capture, so the surface takes the stubs the browser would provide.
  surface.setPointerCapture = vi.fn();
  surface.releasePointerCapture = vi.fn();
  surface.hasPointerCapture = vi.fn(() => false);
  return surface;
}

/** The picture as the browser lays it out: 1000x600 holding a 1280x757 desktop. */
function frameImage() {
  const img = container.querySelector<HTMLImageElement>('[data-testid="computer-live-frame"] img');
  if (!img) throw new Error("the live frame has no picture");
  Object.defineProperty(img, "naturalWidth", { configurable: true, value: 1280 });
  Object.defineProperty(img, "naturalHeight", { configurable: true, value: 757 });
  img.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 600);
  return img;
}

async function fire(target: EventTarget, event: Event) {
  await act(async () => {
    target.dispatchEvent(event);
  });
}

function pointer(type: string, init: PointerEventInit = {}) {
  return new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, ...init });
}

/** Every input the frame sent, in order. */
function sentInputs() {
  return frameMocks.mutate.mock.calls.map(([input]) => input);
}

it("sends a pointer down and up for a click on a live frame held with control", async () => {
  await renderLive();
  const surface = liveSurface();
  const img = frameImage();
  expect(surface.getAttribute("role")).toBe("application");
  expect(surface.tabIndex).toBe(0);

  await fire(img, pointer("pointerdown", { clientX: 500, clientY: 300, button: 0, buttons: 1 }));
  await fire(img, pointer("pointerup", { clientX: 500, clientY: 300, button: 0, buttons: 0 }));

  expect(frameMocks.mutate).toHaveBeenCalledTimes(2);
  const [down, up] = sentInputs();
  expect(down).toMatchObject({
    botId: "bot-1",
    kind: "pointer",
    payload: { type: "down", button: "left", buttons: 1 },
  });
  expect(up).toMatchObject({
    botId: "bot-1",
    kind: "pointer",
    payload: { type: "up", button: "left", buttons: 0 },
  });
  // 500,300 on a 1000x600 letterbox of a 1280x757 desktop is the page's own 640,379.
  expect(down.payload).toMatchObject({ x: 640, y: 379 });
  for (const { x, y } of [down.payload, up.payload]) {
    expect(Number.isInteger(x)).toBe(true);
    expect(Number.isInteger(y)).toBe(true);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThan(1280);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThan(757);
  }
  expect(frameMocks.invalidateQueries).toHaveBeenCalled();
});

it("sends a drag as a move that keeps the button held", async () => {
  await renderLive();
  const surface = liveSurface();
  const img = frameImage();

  await fire(img, pointer("pointerdown", { clientX: 500, clientY: 300, button: 0, buttons: 1 }));
  await fire(surface, pointer("pointermove", { clientX: 600, clientY: 300, buttons: 1 }));
  await fire(surface, pointer("pointerup", { clientX: 600, clientY: 300, button: 0, buttons: 0 }));

  const [down, move, up] = sentInputs();
  expect([down, move, up].map((input) => input.payload.type)).toEqual(["down", "move", "up"]);
  expect(move).toMatchObject({
    botId: "bot-1",
    kind: "pointer",
    payload: { type: "move", button: "left", x: 768, y: 379 },
  });
  expect(move.payload.buttons).toBeGreaterThan(0);
  expect(up.payload.type).toBe("up");
});

it("captures the pointer for a drag and never starts a picture drag", async () => {
  await renderLive();
  const surface = liveSurface();
  const img = frameImage();

  await fire(img, pointer("pointerdown", { clientX: 500, clientY: 300, button: 0, buttons: 1 }));
  // The surface keeps the pointer, so a drag that leaves the frame still reaches the page.
  expect(surface.setPointerCapture).toHaveBeenCalledWith(7);

  // The picture is never the thing being dragged; the page's own selection is what moves.
  const dragStart = new Event("dragstart", { bubbles: true, cancelable: true });
  await fire(img, dragStart);
  expect(dragStart.defaultPrevented).toBe(true);
});

it("sends the wheel as a scroll with its direction and amount", async () => {
  await renderLive();
  const surface = liveSurface();
  frameImage();

  const wheel = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    clientX: 500,
    clientY: 300,
    deltaX: 0,
    deltaY: 300,
  });
  await fire(surface, wheel);

  expect(frameMocks.mutate).toHaveBeenCalledOnce();
  expect(frameMocks.mutate).toHaveBeenCalledWith({
    botId: "bot-1",
    kind: "scroll",
    payload: { direction: "down", amount: 3, x: 640, y: 379 },
  });
  expect(wheel.defaultPrevented).toBe(true);
});

it("sends a pressed key to the page as a key input", async () => {
  await renderLive();
  const surface = liveSurface();

  const keydown = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  await fire(surface, keydown);

  expect(frameMocks.mutate).toHaveBeenCalledOnce();
  expect(frameMocks.mutate).toHaveBeenCalledWith({
    botId: "bot-1",
    kind: "key",
    payload: { key: "Enter", modifiers: [] },
  });
  expect(keydown.defaultPrevented).toBe(true);
});

it("sends nothing and keeps the live frame out of the tab order without control", async () => {
  await renderLive({ hasControl: false });
  const surface = liveSurface();
  const img = frameImage();
  expect(surface.tabIndex).toBe(-1);

  await fire(img, pointer("pointerdown", { clientX: 500, clientY: 300, button: 0, buttons: 1 }));
  await fire(surface, pointer("pointermove", { clientX: 600, clientY: 300, buttons: 1 }));
  await fire(surface, pointer("pointerup", { clientX: 600, clientY: 300, button: 0, buttons: 0 }));
  await fire(
    surface,
    new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: 500,
      clientY: 300,
      deltaY: 300,
    }),
  );
  await fire(
    surface,
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );

  expect(frameMocks.mutate).not.toHaveBeenCalled();
  expect(frameMocks.invalidateQueries).not.toHaveBeenCalled();
  expect(container.querySelector('[role="toolbar"]')).toBeNull();
});

it("shows the live frame as a picture that cannot be dragged or selected", async () => {
  await renderLive();
  const surface = liveSurface();
  const img = frameImage();

  expect(img.getAttribute("src")).toBe(PREVIEW_IMAGE);
  expect(img.draggable).toBe(false);
  for (const className of [
    "select-none",
    "touch-none",
    "overscroll-none",
    "[-webkit-tap-highlight-color:transparent]",
    "[-webkit-touch-callout:none]",
  ]) {
    expect(img.classList.contains(className)).toBe(true);
    expect(surface.classList.contains(className)).toBe(true);
  }
  expect(surface.classList.contains("cursor-default")).toBe(true);
  expect(surface.classList.contains("cursor-crosshair")).toBe(false);
  expect(img.classList.contains("[-webkit-user-drag:none]")).toBe(true);
  expect(surface.classList.contains("[-webkit-user-drag:none]")).toBe(true);
});

it("counts two presses in the same spot as a double click", async () => {
  await renderLive();
  const surface = liveSurface();
  const img = frameImage();

  for (const type of ["pointerdown", "pointerup", "pointerdown", "pointerup"]) {
    await fire(
      type === "pointerdown" ? img : surface,
      pointer(type, {
        clientX: 500,
        clientY: 300,
        button: 0,
        buttons: type === "pointerdown" ? 1 : 0,
      }),
    );
  }

  const clicks = sentInputs().map((input) => input.payload);
  expect(clicks.map((payload) => [payload.type, payload.clickCount])).toEqual([
    ["down", 1],
    ["up", 1],
    ["down", 2],
    ["up", 2],
  ]);
});

it("sends a held key again each time the key repeats", async () => {
  await renderLive();
  const surface = liveSurface();

  const repeat = () =>
    new KeyboardEvent("keydown", {
      key: "Backspace",
      bubbles: true,
      cancelable: true,
      repeat: true,
    });
  await fire(surface, repeat());
  await fire(surface, repeat());

  expect(frameMocks.mutate).toHaveBeenCalledTimes(2);
  expect(frameMocks.mutate).toHaveBeenNthCalledWith(2, {
    botId: "bot-1",
    kind: "key",
    payload: { key: "Backspace", modifiers: [] },
  });
});

it("sends a printable key from the hidden field and a paste as text", async () => {
  await renderLive();
  const surface = liveSurface();
  const input = surface.querySelector("input");
  if (!input) throw new Error("the live frame has no text field");

  const keydown = new KeyboardEvent("keydown", {
    key: "a",
    bubbles: true,
    cancelable: true,
  });
  await fire(input, keydown);
  expect(frameMocks.mutate).toHaveBeenNthCalledWith(1, {
    botId: "bot-1",
    kind: "key",
    payload: { key: "a", modifiers: [] },
  });
  expect(keydown.defaultPrevented).toBe(true);

  // A paste never presses a key this surface knows, so its value is the text to send.
  input.value = "hi";
  await fire(input, new Event("input", { bubbles: true }));
  expect(frameMocks.mutate).toHaveBeenNthCalledWith(2, {
    botId: "bot-1",
    kind: "clipboard",
    payload: { text: "hi" },
  });
  expect(input.value).toBe("");
});

it("focuses the hidden text field when a pointer presses the picture", async () => {
  await renderLive();
  const surface = liveSurface();
  const img = frameImage();
  // Taking control focuses the field already; a press has to bring focus back on its own.
  (document.activeElement as HTMLElement | null)?.blur();

  await fire(img, pointer("pointerdown", { clientX: 500, clientY: 300, button: 0, buttons: 1 }));

  const input = surface.querySelector("input");
  expect(input).not.toBeNull();
  expect(document.activeElement).toBe(input);
});

it("treats a tap as a click with its click count and opens the keyboard", async () => {
  await renderLive();
  const surface = liveSurface();
  const img = frameImage();
  (document.activeElement as HTMLElement | null)?.blur();

  await fire(
    img,
    pointer("pointerdown", {
      pointerType: "touch",
      clientX: 500,
      clientY: 300,
      button: 0,
      buttons: 1,
    }),
  );
  await fire(
    surface,
    pointer("pointerup", {
      pointerType: "touch",
      clientX: 500,
      clientY: 300,
      button: 0,
      buttons: 0,
    }),
  );

  const [down, up] = sentInputs();
  expect(down.payload).toMatchObject({
    type: "down",
    button: "left",
    buttons: 1,
    clickCount: 1,
    x: 640,
    y: 379,
  });
  expect(up.payload).toMatchObject({ type: "up", buttons: 0, clickCount: 1 });
  expect(document.activeElement).toBe(surface.querySelector("input"));
});

it("scrolls the page the other way when a finger drags over it", async () => {
  await renderLive();
  const surface = liveSurface();
  const img = frameImage();

  await fire(
    img,
    pointer("pointerdown", {
      pointerType: "touch",
      clientX: 500,
      clientY: 300,
      button: 0,
      buttons: 1,
    }),
  );
  // Forty CSS pixels to the left is more than a slop and one notch of 30 page pixels.
  await fire(
    surface,
    pointer("pointermove", {
      pointerType: "touch",
      clientX: 460,
      clientY: 300,
      buttons: 1,
    }),
  );
  await fire(
    surface,
    pointer("pointerup", {
      pointerType: "touch",
      clientX: 460,
      clientY: 300,
      button: 0,
      buttons: 0,
    }),
  );

  expect(sentInputs()).toEqual([
    { botId: "bot-1", kind: "scroll", payload: { direction: "right", amount: 1, x: 589, y: 379 } },
  ]);
});

it("holds a long press as a drag on the page", async () => {
  await renderLive();
  const surface = liveSurface();
  const img = frameImage();

  await fire(
    img,
    pointer("pointerdown", {
      pointerType: "touch",
      clientX: 500,
      clientY: 300,
      button: 0,
      buttons: 1,
    }),
  );
  // The press turns into a drag once it has been held without travelling.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 470));
  });
  await fire(
    surface,
    pointer("pointermove", {
      pointerType: "touch",
      clientX: 550,
      clientY: 300,
      buttons: 1,
    }),
  );
  await fire(
    surface,
    pointer("pointerup", {
      pointerType: "touch",
      clientX: 550,
      clientY: 300,
      button: 0,
      buttons: 0,
    }),
  );

  expect(sentInputs().map((input) => input.payload.type)).toEqual(["down", "move", "up"]);
  expect(sentInputs()[0]?.payload).toMatchObject({ type: "down", buttons: 1, clickCount: 1 });
});

it("drops a cancelled touch without sending it", async () => {
  await renderLive();
  const surface = liveSurface();
  const img = frameImage();

  await fire(
    img,
    pointer("pointerdown", {
      pointerType: "touch",
      clientX: 500,
      clientY: 300,
      button: 0,
      buttons: 1,
    }),
  );
  await fire(
    surface,
    pointer("pointercancel", { pointerType: "touch", clientX: 500, clientY: 300, buttons: 0 }),
  );

  expect(frameMocks.mutate).not.toHaveBeenCalled();
});

it("counts three taps in the same spot as a triple click", async () => {
  await renderLive();
  const surface = liveSurface();
  const img = frameImage();

  for (let tap = 0; tap < 3; tap += 1) {
    await fire(
      img,
      pointer("pointerdown", {
        pointerType: "touch",
        clientX: 500,
        clientY: 300,
        button: 0,
        buttons: 1,
      }),
    );
    await fire(
      surface,
      pointer("pointerup", {
        pointerType: "touch",
        clientX: 500,
        clientY: 300,
        button: 0,
        buttons: 0,
      }),
    );
  }

  expect(sentInputs().map((input) => [input.payload.type, input.payload.clickCount])).toEqual([
    ["down", 1],
    ["up", 1],
    ["down", 2],
    ["up", 2],
    ["down", 3],
    ["up", 3],
  ]);
});

it("scrolls down the page when a finger drags up the picture", async () => {
  await renderLive();
  const surface = liveSurface();
  const img = frameImage();

  await fire(
    img,
    pointer("pointerdown", {
      pointerType: "touch",
      clientX: 500,
      clientY: 300,
      button: 0,
      buttons: 1,
    }),
  );
  // Forty CSS pixels up is more than a slop and one notch of 30 page pixels.
  await fire(
    surface,
    pointer("pointermove", { pointerType: "touch", clientX: 500, clientY: 260, buttons: 1 }),
  );

  expect(sentInputs()).toEqual([
    { botId: "bot-1", kind: "scroll", payload: { direction: "down", amount: 1, x: 640, y: 327 } },
  ]);
});

it("sends the strip's page keys without clicking the page", async () => {
  await renderLive();
  const surface = liveSurface();
  frameImage();

  const strip = surface.querySelector('[role="toolbar"]');
  expect(strip).not.toBeNull();
  const escapeKey = strip?.querySelector<HTMLButtonElement>('button[aria-label="Escape"]');
  if (!escapeKey) throw new Error("the strip has no Escape key");
  const input = surface.querySelector("input");
  input?.focus();

  // A finger on the strip belongs to the button, not to the page under it.
  await fire(
    escapeKey,
    pointer("pointerdown", {
      pointerType: "touch",
      clientX: 50,
      clientY: 570,
      button: 0,
      buttons: 1,
    }),
  );
  expect(frameMocks.mutate).not.toHaveBeenCalled();

  await act(async () => escapeKey.click());
  expect(frameMocks.mutate).toHaveBeenCalledOnce();
  expect(frameMocks.mutate).toHaveBeenCalledWith({
    botId: "bot-1",
    kind: "key",
    payload: { key: "Escape", modifiers: [] },
  });
  // The strip keeps the page's field focused, so the phone keyboard stays with it.
  expect(document.activeElement).toBe(input);
});
