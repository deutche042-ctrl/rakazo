/**
 * The live surface's shared vocabulary: how fast it refreshes, how far a finger may drift before a
 * gesture means something else, and the keys the page takes as presses rather than as text.
 */

/** The preview refreshes a frame a second, and faster for a moment after someone touches the page. */
export const LIVE_PREVIEW_MS = 1_000;
export const LIVE_PREVIEW_AFTER_INPUT_MS = 350;
export const LIVE_PREVIEW_AFTER_INPUT_FOR_MS = 2_000;
/** A pointer stream is faster than the page redraws, so moves leave at this pace instead. */
export const LIVE_MOVE_MS = 50;
/** Two presses inside this window at nearly the same spot make a double, then a triple click. */
export const LIVE_MULTI_CLICK_MS = 400;
/**
 * Measured in CSS pixels, not page pixels: the picture is scaled to fit a phone, so a page-pixel
 * threshold would shrink with the picture and no finger could ever stay inside it. A mouse lands
 * within a pixel or two; a finger wobbles far more, so a tap gets its own, wider ring.
 */
export const LIVE_MULTI_CLICK_SLOP_PX = 4;
export const LIVE_MULTI_CLICK_TOUCH_SLOP_PX = 16;
/** A hundred pixels of wheel is one notch; a long flick is worth several. */
export const LIVE_SCROLL_PX_PER_NOTCH = 100;
export const LIVE_SCROLL_MAX_AMOUNT = 20;
/** A finger has to travel this far before it means a scroll rather than a tap. */
export const LIVE_TOUCH_SLOP_PX = 8;
/** Holding a finger still this long starts a drag, so a press can select text on the page. */
export const LIVE_TOUCH_LONG_PRESS_MS = 450;
/** A phone's screen is small, so its finger travel maps to shorter notches than a wheel's. */
export const LIVE_TOUCH_SCROLL_PX_PER_NOTCH = 30;

export type LiveInputKind = "pointer" | "key" | "scroll" | "clipboard";
export type LiveButton = "left" | "right";

/** One finger on the surface, from the press until it lifts or is cancelled. */
export type TouchGesture = {
  id: number;
  /** The first and last page points, in the page's own pixels. */
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  /** The same start in CSS pixels, where the slop threshold is measured. */
  startClientX: number;
  startClientY: number;
  mode: "pending" | "scroll" | "drag";
};

/** Keys a page takes as a press; a printable character is sent as itself. */
export const LIVE_KEYS = new Set(
  // Escape is left out on purpose: the computer's window closes on it, and the strip's Esc key
  // sends it to the page instead, so a person is never trapped in a window they cannot leave.
  "Enter|Tab|Backspace|Delete| |ArrowLeft|ArrowRight|ArrowUp|ArrowDown|PageDown|PageUp|Home|End".split(
    "|",
  ),
);

/** A modifier on its own presses nothing; it travels with the key it is held for. */
export const LIVE_MODIFIER_KEYS = new Set(
  "Alt AltGraph CapsLock Control Fn FnLock Hyper Meta NumLock ScrollLock Shift Super Symbol SymbolLock".split(
    " ",
  ),
);

export function liveModifiers(event: {
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
export function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    Boolean(target.closest("input, textarea, select, [contenteditable='true']"))
  );
}

export function liveButtons(button: LiveButton): number {
  return button === "left" ? 1 : 2;
}
