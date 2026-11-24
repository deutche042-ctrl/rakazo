import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Bot, ComputerReleaseReason, ComputerStatus } from "@rakazo/contracts";
import { computerPreviewPlaceholder } from "@rakazo/i18n/computer-preview";
import { BotAvatar, Button } from "@rakazo/ui-web";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, HardDrive, Maximize2, X } from "lucide-react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useEffect, useRef, useState } from "react";
import { ComputersUnavailableHint } from "../../../components/computers/ComputersUnavailableHint";
import { runsOnUserMachine } from "../../../lib/computers/computer-sandbox";
import { screenFrames, screenIframeSandbox } from "../../../lib/computers/computer-screen";
import { useSpaceQueries } from "../../../lib/query/query";
import { DesktopKindEmptyState } from "./computer-view";

type ComputerPanelProps = {
  bot: Bot;
  computer: ComputerStatus | null;
  computerOpen: boolean;
  embeddedScreenUrl: string | null;
  /** Changes to load the screen again in a new frame. */
  screenFrameKey?: string;
  heldScreen?: { url: string; key: string } | null;
  screenFrameRef: (frame: HTMLIFrameElement | null) => void;
  computerScreenError: ReactNode;
  computerBooting: ReactNode;
  booting: boolean;
  showingRecoveryHint: boolean;
  showComputerRecoveryHint: boolean;
  sandboxProvider?: string | null;
  onRecovered: (sandboxProvider: string) => void;
  onRecoveryDismissed: () => void;
  onOpenComputerSettings?: () => void;
  onOpen: () => void;
  /** Whether this person holds the shared browser's control right now. */
  hasControl?: boolean;
  /** Ask for the shared browser's control without opening the full window. */
  onTakeControl?: () => void;
  /** Hand that control back. */
  onRelease?: (reason?: ComputerReleaseReason) => Promise<void>;
  cleaningUpDisk?: boolean;
  onCleanUpDisk?: () => void;
  onDismissDiskWarning?: () => void;
};

export function ComputerPanel({
  cleaningUpDisk,
  onCleanUpDisk,
  onDismissDiskWarning,
  ...props
}: ComputerPanelProps) {
  const percent = props.computer?.diskFullPercent;
  const warn = percent !== undefined && onCleanUpDisk && onDismissDiskWarning;
  const tabs = props.computer?.browserTabs ?? [];
  // The preview keeps its place either way, so the warning never remounts the live screen.
  return (
    <>
      {tabs.length ? <BrowserTabsPanel tabs={tabs} /> : null}
      <ComputerPreview {...props} />
      {warn && (
        <div
          data-testid="computer-disk-warning"
          className="mt-2 flex items-center gap-2 rounded-[14px] border border-warning/40 py-1.5 ps-3 pe-1.5 text-body"
        >
          <HardDrive aria-hidden size={15} strokeWidth={1.9} className="shrink-0 text-warning" />
          <span className="min-w-0 flex-1">
            <Trans>Computer is {percent}% full</Trans>
          </span>
          <Button variant="secondary" size="sm" disabled={cleaningUpDisk} onClick={onCleanUpDisk}>
            <Trans>Clean up</Trans>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t`Dismiss`}
            onClick={onDismissDiskWarning}
          >
            <X size={15} aria-hidden />
          </Button>
        </div>
      )}
    </>
  );
}

/** The preview refreshes a frame a second, and faster for a moment after someone touches the page. */
const LIVE_PREVIEW_MS = 1_000;
const LIVE_PREVIEW_AFTER_INPUT_MS = 350;
const LIVE_PREVIEW_AFTER_INPUT_FOR_MS = 2_000;
/** A pointer stream is faster than the page redraws, so moves leave at this pace instead. */
const LIVE_MOVE_MS = 50;
/** Two presses inside this window at nearly the same spot make a double, then a triple click. */
const LIVE_MULTI_CLICK_MS = 400;
const LIVE_MULTI_CLICK_SLOP_PX = 4;
/** A hundred pixels of wheel is one notch; a long flick is worth several. */
const LIVE_SCROLL_PX_PER_NOTCH = 100;
const LIVE_SCROLL_MAX_AMOUNT = 20;

type LiveInputKind = "pointer" | "key" | "scroll";
type LiveButton = "left" | "right";

/** Keys a page takes as a press; a printable character is sent as itself. */
const LIVE_KEYS = new Set([
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "Escape",
  " ",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "PageDown",
  "PageUp",
  "Home",
  "End",
]);

/** A modifier on its own presses nothing; it travels with the key it is held for. */
const LIVE_MODIFIER_KEYS = new Set([
  "Alt",
  "AltGraph",
  "CapsLock",
  "Control",
  "Fn",
  "FnLock",
  "Hyper",
  "Meta",
  "NumLock",
  "ScrollLock",
  "Shift",
  "Super",
  "Symbol",
  "SymbolLock",
]);

function liveModifiers(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): string[] {
  const modifiers: string[] = [];
  if (event.altKey) modifiers.push("alt");
  if (event.ctrlKey) modifiers.push("control");
  if (event.metaKey) modifiers.push("meta");
  if (event.shiftKey) modifiers.push("shift");
  return modifiers;
}

/** A text field inside the surface keeps its own keys; the page gets everything else. */
function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    Boolean(target.closest("input, textarea, select, [contenteditable='true']"))
  );
}

function liveButtons(button: LiveButton): number {
  return button === "left" ? 1 : 2;
}

/** The shared browser's page, one frame a second, rendered where the computer screen used to be. */
export function BrowserLiveFrame({
  bot,
  interactive = false,
  onInput,
}: {
  bot: Bot;
  /** Whether clicks, drags, the wheel and keys landed here belong to the page instead. */
  interactive?: boolean;
  /** One thing a person did to the page, in the page's own pixels. */
  onInput?: (kind: LiveInputKind, payload: Record<string, unknown>) => void;
}) {
  const queries = useSpaceQueries();
  // A page that just took input is the one worth seeing next, so the preview runs at a live pace
  // for a moment afterwards instead of waiting out the usual second.
  const [live, setLive] = useState(false);
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const preview = useQuery({
    ...queries.computer.preview.queryOptions({ input: { botId: bot.id } }),
    retry: false,
    refetchInterval: live ? LIVE_PREVIEW_AFTER_INPUT_MS : LIVE_PREVIEW_MS,
    refetchIntervalInBackground: false,
    gcTime: 0,
    staleTime: 0,
  });
  useEffect(
    () => () => {
      if (liveTimer.current) clearTimeout(liveTimer.current);
    },
    [],
  );
  function noteInput() {
    setLive(true);
    if (liveTimer.current) clearTimeout(liveTimer.current);
    liveTimer.current = setTimeout(() => setLive(false), LIVE_PREVIEW_AFTER_INPUT_FOR_MS);
  }
  const image = preview.data?.image ?? null;
  if (!image)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-body text-muted-foreground/80">
        <Globe size={22} strokeWidth={1.7} aria-hidden />
        <Trans>Waiting for the browser…</Trans>
      </div>
    );
  return (
    <LiveSurface
      image={image}
      previewKey={queries.computer.preview.queryKey({ input: { botId: bot.id } })}
      interactive={interactive}
      onInput={onInput}
      onInputSent={noteInput}
    />
  );
}

/** The frame's own input surface: pointer capture, the wheel, the keys and the focus ring. */
function LiveSurface({
  image,
  previewKey,
  interactive,
  onInput,
  onInputSent,
}: {
  image: string;
  /** The preview read an input makes out of date. */
  previewKey: readonly unknown[];
  interactive: boolean;
  onInput?: (kind: LiveInputKind, payload: Record<string, unknown>) => void;
  onInputSent: () => void;
}) {
  const queryClient = useQueryClient();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  // React's wheel listener is passive, so the handler below outlives a render; the latest sender
  // is read from a ref so it always reports for this frame, not the one it was created with.
  const inputRef = useRef(onInput);
  inputRef.current = onInput;
  const sentRef = useRef(onInputSent);
  sentRef.current = onInputSent;
  const previewKeyRef = useRef(previewKey);
  previewKeyRef.current = previewKey;
  const pressedRef = useRef<{ id: number; button: LiveButton } | null>(null);
  const moveRef = useRef<{ x: number; y: number; button: LiveButton } | null>(null);
  const moveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clickRef = useRef<{
    at: number;
    x: number;
    y: number;
    button: LiveButton;
    count: number;
  } | null>(null);
  const heldKeysRef = useRef(new Set<string>());

  useEffect(
    () => () => {
      if (moveTimerRef.current) clearTimeout(moveTimerRef.current);
    },
    [],
  );

  function send(kind: LiveInputKind, payload: Record<string, unknown>) {
    if (!interactive || !inputRef.current) return;
    inputRef.current(kind, payload);
    // The page has probably moved on: ask for the next frame at once. Keeping the read already
    // on its way means a drag never stacks requests and the frame that paints is the one asked.
    void queryClient.invalidateQueries(
      { queryKey: previewKeyRef.current },
      { cancelRefetch: false },
    );
    // And keep the preview at a live pace for a moment after the last input.
    sentRef.current();
  }

  function pagePoint(clientX: number, clientY: number) {
    const img = imageRef.current;
    if (!img?.naturalWidth || !img.naturalHeight) return null;
    const rect = img.getBoundingClientRect();
    // The image is letterboxed by object-contain; map through the drawn content box.
    const scale = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
    if (!(scale > 0)) return null;
    const drawnWidth = img.naturalWidth * scale;
    const drawnHeight = img.naturalHeight * scale;
    const x = (clientX - rect.left - (rect.width - drawnWidth) / 2) / scale;
    const y = (clientY - rect.top - (rect.height - drawnHeight) / 2) / scale;
    return {
      x: Math.min(Math.max(Math.round(x), 0), img.naturalWidth - 1),
      y: Math.min(Math.max(Math.round(y), 0), img.naturalHeight - 1),
      // A drag may run off the frame; a press that starts off it is not a click on the page.
      inside: x >= 0 && y >= 0 && x <= img.naturalWidth && y <= img.naturalHeight,
    };
  }

  function flushMove() {
    if (moveTimerRef.current) {
      clearTimeout(moveTimerRef.current);
      moveTimerRef.current = null;
    }
    const move = moveRef.current;
    if (!move) return;
    moveRef.current = null;
    send("pointer", {
      x: move.x,
      y: move.y,
      type: "move",
      button: move.button,
      buttons: liveButtons(move.button),
    });
    moveTimerRef.current = setTimeout(() => {
      moveTimerRef.current = null;
      flushMove();
    }, LIVE_MOVE_MS);
  }

  function queueMove(point: { x: number; y: number }, button: LiveButton) {
    moveRef.current = { ...point, button };
    if (!moveTimerRef.current) flushMove();
  }

  function countClick(point: { x: number; y: number }, button: LiveButton, at: number) {
    const previous = clickRef.current;
    const count =
      previous &&
      previous.button === button &&
      at - previous.at <= LIVE_MULTI_CLICK_MS &&
      Math.abs(previous.x - point.x) <= LIVE_MULTI_CLICK_SLOP_PX &&
      Math.abs(previous.y - point.y) <= LIVE_MULTI_CLICK_SLOP_PX
        ? Math.min(previous.count + 1, 3)
        : 1;
    clickRef.current = { at, x: point.x, y: point.y, button, count };
    return count;
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!interactive) return;
    const button: LiveButton | null =
      event.button === 0 ? "left" : event.button === 2 ? "right" : null;
    if (!button || pressedRef.current) return;
    const point = pagePoint(event.clientX, event.clientY);
    if (!point?.inside) return;
    event.preventDefault();
    // The surface keeps the pointer, so a drag that leaves the frame still belongs to the page.
    event.currentTarget.setPointerCapture(event.pointerId);
    // The keys that follow a click belong to the page as well.
    event.currentTarget.focus({ preventScroll: true });
    pressedRef.current = { id: event.pointerId, button };
    send("pointer", {
      x: point.x,
      y: point.y,
      type: "down",
      button,
      buttons: liveButtons(button),
      clickCount: countClick(point, button, event.timeStamp),
    });
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const pressed = pressedRef.current;
    if (!pressed || pressed.id !== event.pointerId) return;
    // Releasing the pressed button while another stays held fires pointermove, not pointerup.
    if (!(event.buttons & liveButtons(pressed.button))) {
      release(event);
      return;
    }
    const point = pagePoint(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    queueMove(point, pressed.button);
  }

  function release(event: ReactPointerEvent<HTMLDivElement>) {
    const pressed = pressedRef.current;
    if (!pressed) return;
    pressedRef.current = null;
    if (moveTimerRef.current) {
      clearTimeout(moveTimerRef.current);
      moveTimerRef.current = null;
    }
    // The release has to land where the pointer is, so the last move goes first.
    const move = moveRef.current;
    moveRef.current = null;
    if (move)
      send("pointer", {
        x: move.x,
        y: move.y,
        type: "move",
        button: pressed.button,
        buttons: liveButtons(pressed.button),
      });
    const surface = surfaceRef.current;
    if (surface?.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
    const point = pagePoint(event.clientX, event.clientY);
    if (!point) return;
    send("pointer", {
      x: point.x,
      y: point.y,
      type: "up",
      button: pressed.button,
      buttons: event.buttons,
      clickCount: clickRef.current?.count ?? 1,
    });
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (pressedRef.current?.id === event.pointerId) release(event);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!interactive || event.isComposing) return;
    if (isEditableTarget(event.target)) return;
    const key = event.key;
    if (LIVE_MODIFIER_KEYS.has(key) || (!LIVE_KEYS.has(key) && key.length !== 1)) return;
    // These would move focus, scroll this page or submit something here instead of the page.
    event.preventDefault();
    // Held keys repeat; the page gets one press for the press, not one per repeat.
    if (event.repeat) return;
    heldKeysRef.current.add(key);
    send("key", { key, modifiers: liveModifiers(event) });
  }

  function onKeyUp(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!interactive) return;
    const key = event.key;
    // Its press went out on keydown, so the page never sees the same key twice.
    if (heldKeysRef.current.delete(key)) return;
    // A key already held when focus arrived still reaches the page once.
    if (isEditableTarget(event.target) || LIVE_MODIFIER_KEYS.has(key) || key.length !== 1) return;
    send("key", { key, modifiers: liveModifiers(event) });
  }

  // React listens for the wheel passively, so the page would scroll before this frame claimed it.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || !interactive) return;
    function onWheel(event: WheelEvent) {
      event.preventDefault();
      const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY);
      const delta = sideways ? event.deltaX : event.deltaY;
      if (!delta) return;
      const point = pagePoint(event.clientX, event.clientY);
      if (!point) return;
      const direction = sideways ? (delta < 0 ? "left" : "right") : delta < 0 ? "up" : "down";
      const amount = Math.min(
        LIVE_SCROLL_MAX_AMOUNT,
        Math.max(1, Math.round(Math.abs(delta) / LIVE_SCROLL_PX_PER_NOTCH)),
      );
      send("scroll", { direction, amount, x: point.x, y: point.y });
    }
    surface.addEventListener("wheel", onWheel, { passive: false });
    return () => surface.removeEventListener("wheel", onWheel);
    // `send` and `pagePoint` read the latest handlers from refs, so only control reattaches this.
  }, [interactive]);

  return (
    <div
      ref={surfaceRef}
      data-testid="computer-live-frame"
      // The frame is a remote screen that takes the keys itself rather than a static picture.
      role="application"
      tabIndex={interactive ? 0 : -1}
      className={`relative h-full touch-none overflow-hidden bg-black outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${
        interactive ? "cursor-crosshair" : ""
      }`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={(event) => {
        if (interactive) event.preventDefault();
      }}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
    >
      <img
        ref={imageRef}
        src={image}
        alt={t`Bot browser`}
        draggable={false}
        className="h-full w-full touch-none object-contain select-none"
      />
      <span className="pointer-events-none absolute start-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-caption text-white">
        <Trans>Live</Trans>
      </span>
    </div>
  );
}

/** The shared browser's open tabs, each labelled with the bot that opened it. */
function BrowserTabsPanel({ tabs }: { tabs: NonNullable<ComputerStatus["browserTabs"]> }) {
  return (
    <div
      data-testid="browser-tabs"
      className="overflow-hidden rounded-xl border border-border/60 bg-muted/30"
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-caption font-medium text-muted-foreground">
        <Globe size={14} strokeWidth={1.9} aria-hidden />
        <Trans>Shared browser</Trans>
      </div>
      <ul className="divide-y divide-border/50">
        {tabs.map((tab) => {
          let host = tab.url;
          try {
            host = new URL(tab.url).host || tab.url;
          } catch {
            // A tab whose URL cannot be parsed still gets its title.
          }
          return (
            <li key={tab.id} className="flex items-center gap-2 px-3 py-2 text-body">
              <span className="max-w-[38%] shrink-0 truncate rounded-full bg-background px-2 py-0.5 text-caption text-muted-foreground">
                {tab.botName ?? <Trans>Unclaimed</Trans>}
              </span>
              <span className="min-w-0 flex-1 truncate">{tab.title || tab.url}</span>
              <span className="max-w-[38%] shrink-0 truncate text-caption text-muted-foreground">
                {host}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A live frame the person holds: its input takes the same route as the full window's. */
function PanelLiveFrame({ bot }: { bot: Bot }) {
  const queries = useSpaceQueries();
  const sendInput = useMutation(queries.computer.input.mutationOptions());
  return (
    <BrowserLiveFrame
      bot={bot}
      interactive
      onInput={(kind, payload) => sendInput.mutate({ botId: bot.id, kind, payload })}
    />
  );
}

function ComputerPreview({
  bot,
  computer,
  computerOpen,
  embeddedScreenUrl,
  screenFrameKey,
  heldScreen,
  screenFrameRef,
  computerScreenError,
  computerBooting,
  booting,
  showingRecoveryHint,
  showComputerRecoveryHint,
  sandboxProvider,
  onRecovered,
  onRecoveryDismissed,
  onOpenComputerSettings,
  onOpen,
  hasControl,
  onTakeControl,
  onRelease,
}: Omit<ComputerPanelProps, "cleaningUpDisk" | "onCleanUpDisk" | "onDismissDiskWarning">) {
  // A clickable preview invites a boot that costs money, so an idle computer only wakes from its button.
  const idle =
    !computerOpen &&
    !booting &&
    !computerBooting &&
    !computerScreenError &&
    !showComputerRecoveryHint &&
    !runsOnUserMachine(computer) &&
    (!computer || computer.state === "stopped" || computer.state === "suspended");
  if (idle) {
    return (
      <div
        data-testid="computer-preview"
        data-state="idle"
        className="flex aspect-[16/10] flex-col items-center justify-center gap-3 rounded-xl bg-muted/50 px-6"
      >
        <span aria-hidden className="relative">
          <BotAvatar
            avatarSet={bot.avatarSet}
            color={bot.color}
            identity={bot.id}
            size={44}
            className="opacity-50 grayscale"
          />
          <span className="absolute -end-3 -top-2 text-caption font-medium leading-none text-muted-foreground/70">
            z<sup>z</sup>
          </span>
        </span>
        <span className="text-body text-muted-foreground">
          <Trans>Asleep</Trans>
        </span>
        <Button variant="secondary" size="sm" data-testid="computer-preview-open" onClick={onOpen}>
          <Trans>Wake</Trans>
        </Button>
      </div>
    );
  }
  // The live frame is the one surface a person can drive from the bot panel; a frame they hold
  // takes the pointer itself, so the Open pill must not sit on top of it.
  const liveFrame =
    !computerOpen &&
    computer?.kind === "desktop" &&
    computer.state === "running" &&
    runsOnUserMachine(computer);
  const canOpen = !computerScreenError && !showingRecoveryHint && !(liveFrame && hasControl);
  // The shared browser is the one computer a person can hold from the bot panel; the full window
  // has its own Take control and Hand back.
  const sharedBrowserFrame =
    !computerOpen &&
    computer?.kind === "desktop" &&
    computer.state === "running" &&
    (computer.browserAvailable === true || runsOnUserMachine(computer));
  // The Open pill replaces the status text on hover; fade it so they never overlap.
  const hideOnHover = canOpen
    ? "transition-opacity group-hover:opacity-0 group-has-[:focus-visible]:opacity-0"
    : "";
  return (
    <div>
      <div
        data-testid="computer-preview"
        data-state={
          computer?.state === "running" && !runsOnUserMachine(computer) ? "running" : undefined
        }
        className={`group relative rounded-xl bg-muted/50 ${
          showingRecoveryHint ? "" : "aspect-[16/10] overflow-hidden"
        }`}
      >
        {computerOpen ? (
          <div
            className={`grid h-full place-items-center text-body text-muted-foreground/80 ${hideOnHover}`}
          >
            <Trans>Open in full window</Trans>
          </div>
        ) : liveFrame ? (
          hasControl ? (
            <PanelLiveFrame bot={bot} />
          ) : (
            <BrowserLiveFrame bot={bot} />
          )
        ) : runsOnUserMachine(computer) ? (
          <DesktopKindEmptyState
            className={`grid h-full place-items-center px-6 text-center text-body text-muted-foreground/80 ${hideOnHover}`}
          />
        ) : computer?.state === "running" && embeddedScreenUrl && !computerScreenError ? (
          screenFrames(screenFrameKey, embeddedScreenUrl, heldScreen).map((frame) => (
            <iframe
              key={frame.key}
              title={frame.held ? undefined : t`Bot screen preview`}
              aria-hidden={frame.held || undefined}
              tabIndex={-1}
              ref={frame.held ? undefined : screenFrameRef}
              src={frame.url}
              sandbox={screenIframeSandbox(frame.url)}
              className={`h-full w-full border-0 bg-black${frame.held ? " absolute inset-0" : ""}`}
              allow="clipboard-read; clipboard-write"
              style={{ pointerEvents: "none" }}
            />
          ))
        ) : (
          <div
            className={`grid h-full place-items-center px-6 text-center text-body text-muted-foreground/80 ${hideOnHover}`}
          >
            {computerScreenError ??
              (showComputerRecoveryHint ? (
                <ComputersUnavailableHint
                  sandboxProvider={sandboxProvider}
                  onRecovered={onRecovered}
                  onRecoveryDismissed={onRecoveryDismissed}
                  onOpenComputerSettings={onOpenComputerSettings}
                />
              ) : (
                (computerBooting ?? computerPreviewPlaceholder(computer?.state, booting))
              ))}
          </div>
        )}
        {canOpen ? (
          <button
            type="button"
            data-testid="computer-preview-open"
            className="absolute inset-0 flex cursor-pointer items-center justify-center bg-overlay/40 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            aria-label={t`Open`}
            onClick={onOpen}
          >
            <span className="inline-flex items-center gap-2 rounded-full bg-background px-3.5 py-2 text-body text-foreground shadow-md">
              <Maximize2 size={15} strokeWidth={1.9} aria-hidden />
              <Trans>Open</Trans>
            </span>
          </button>
        ) : null}
        {sharedBrowserFrame && onTakeControl && onRelease ? (
          <div className="absolute end-2 top-2 z-10">
            {hasControl ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-testid="panel-hand-back-control"
                onClick={() => void onRelease()}
              >
                <Trans>Hand back control</Trans>
              </Button>
            ) : (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-testid="panel-take-control"
                disabled={booting}
                onClick={onTakeControl}
              >
                <Trans>Take control</Trans>
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
