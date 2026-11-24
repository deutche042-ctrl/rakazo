import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  GestureResponderEvent,
  LayoutChangeEvent,
  StyleProp,
  ViewStyle,
} from "react-native";
import { Image, PanResponder, StyleSheet, Text, View } from "react-native";
import type { BrowserLiveInput } from "../../lib/computers/use-browser-live";
import { useMobileTokens } from "../../lib/native/native";

/** A finger has to travel this far before the gesture is a drag or a scroll rather than a tap. */
const TOUCH_SLOP_PX = 10;
/** Holding still this long before moving turns the gesture into a drag (text selection). */
const LONG_PRESS_MS = 300;
/** A pointer stream is faster than the page redraws, so moves leave at this pace instead. */
const MOVE_INTERVAL_MS = 50;
/** Two taps inside this window at nearly the same spot make a double, then a triple click. */
const MULTI_CLICK_MS = 400;
/** Measured on the screen, not the page, so a zoomed-out page still reads a double tap. */
const MULTI_CLICK_SLOP_PX = 12;
/** A hundred page pixels is one wheel notch; a long flick is worth several. */
const SCROLL_PX_PER_NOTCH = 100;
const SCROLL_MAX_AMOUNT = 20;

type PagePoint = { x: number; y: number; inside: boolean };

type Gesture = {
  mode: "pending" | "scroll" | "drag" | "ignored";
  startLocalX: number;
  startLocalY: number;
  startedAt: number;
  /** The press in the page's own pixels; null when the touch began outside the drawn image. */
  start: PagePoint | null;
  last: PagePoint | null;
  clickCount: number;
};

/**
 * The shared browser's page, letterboxed into whatever space it is given. Touch is mapped through
 * the drawn image box to the page's CSS pixels: a tap presses and releases, a hold (or a sideways
 * pull) drags for text selection, and a quick vertical flick scrolls the page under the finger.
 * Touch has no wheel, so scrolling is that flick and nothing else.
 */
export function BrowserLiveFrame({
  image,
  interactive = false,
  onInput,
  placeholder,
  accessibilityLabel,
  style,
  testID,
}: {
  image: string | null;
  /** Whether touches belong to the page instead of the screen around it. */
  interactive?: boolean;
  onInput?: BrowserLiveInput;
  /** Shown until the first frame arrives. */
  placeholder?: ReactNode;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const [layout, setLayout] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const naturalRef = useRef(natural);
  naturalRef.current = natural;
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;
  const inputRef = useRef(onInput);
  inputRef.current = onInput;

  const gesture = useRef<Gesture | null>(null);
  const pendingMove = useRef<{ x: number; y: number } | null>(null);
  const moveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const click = useRef<{ at: number; x: number; y: number; count: number } | null>(null);

  // The page's own size is what touch is mapped into. The image reports it when it paints; the
  // first frame is also measured directly, so a platform that omits it on load still maps right.
  useEffect(() => {
    if (!image || natural) return;
    let live = true;
    Image.getSize(
      image,
      (width, height) => {
        if (!live || width <= 0 || height <= 0) return;
        setNatural((current) =>
          current && current.width === width && current.height === height
            ? current
            : { width, height },
        );
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [image, natural]);

  useEffect(
    () => () => {
      if (moveTimer.current) clearTimeout(moveTimer.current);
    },
    [],
  );

  function send(kind: Parameters<BrowserLiveInput>[0], payload: Record<string, unknown>) {
    if (!interactiveRef.current) return;
    inputRef.current?.(kind, payload);
  }

  function sendPointer(point: PagePoint, type: "down" | "move" | "up", clickCount: number) {
    send("pointer", {
      x: point.x,
      y: point.y,
      type,
      button: "left",
      buttons: type === "up" ? 0 : 1,
      ...(type === "move" ? {} : { clickCount }),
    });
  }

  /** Map a touch in this view to the page, through the letterbox `resizeMode="contain"` draws. */
  function pagePoint(localX: number, localY: number): PagePoint | null {
    const size = naturalRef.current;
    const box = layoutRef.current;
    if (!size || size.width <= 0 || size.height <= 0) return null;
    if (box.width <= 0 || box.height <= 0) return null;
    const scale = Math.min(box.width / size.width, box.height / size.height);
    if (!(scale > 0)) return null;
    const drawnWidth = size.width * scale;
    const drawnHeight = size.height * scale;
    const x = (localX - (box.width - drawnWidth) / 2) / scale;
    const y = (localY - (box.height - drawnHeight) / 2) / scale;
    return {
      x: Math.min(Math.max(Math.round(x), 0), size.width - 1),
      y: Math.min(Math.max(Math.round(y), 0), size.height - 1),
      // A drag may run off the frame; a press that starts off it is not a click on the page.
      inside: x >= 0 && y >= 0 && x <= size.width && y <= size.height,
    };
  }

  function clickCountFor(localX: number, localY: number, at: number) {
    const previous = click.current;
    const count =
      previous &&
      at - previous.at <= MULTI_CLICK_MS &&
      Math.abs(previous.x - localX) <= MULTI_CLICK_SLOP_PX &&
      Math.abs(previous.y - localY) <= MULTI_CLICK_SLOP_PX
        ? Math.min(previous.count + 1, 3)
        : 1;
    click.current = { at, x: localX, y: localY, count };
    return count;
  }

  function flushMove() {
    if (moveTimer.current) {
      clearTimeout(moveTimer.current);
      moveTimer.current = null;
    }
    const move = pendingMove.current;
    if (!move) return;
    pendingMove.current = null;
    sendPointer({ x: move.x, y: move.y, inside: true }, "move", 1);
    moveTimer.current = setTimeout(() => {
      moveTimer.current = null;
      flushMove();
    }, MOVE_INTERVAL_MS);
  }

  function queueMove(point: PagePoint) {
    pendingMove.current = { x: point.x, y: point.y };
    if (!moveTimer.current) flushMove();
  }

  /** The release has to land where the pointer is, so the last move goes first. */
  function flushPendingMove() {
    if (moveTimer.current) {
      clearTimeout(moveTimer.current);
      moveTimer.current = null;
    }
    const move = pendingMove.current;
    pendingMove.current = null;
    if (move) sendPointer({ x: move.x, y: move.y, inside: true }, "move", 1);
  }

  function stopMove() {
    if (moveTimer.current) {
      clearTimeout(moveTimer.current);
      moveTimer.current = null;
    }
    pendingMove.current = null;
  }

  function grant(event: GestureResponderEvent) {
    // A previous gesture left nothing to send; a move timer must not outlive it.
    stopMove();
    const localX = event.nativeEvent.locationX;
    const localY = event.nativeEvent.locationY;
    const point = pagePoint(localX, localY);
    gesture.current = {
      mode: point?.inside ? "pending" : "ignored",
      startLocalX: localX,
      startLocalY: localY,
      startedAt: Date.now(),
      start: point,
      last: point,
      clickCount: 1,
    };
  }

  function move(event: GestureResponderEvent) {
    const current = gesture.current;
    if (!current || current.mode === "ignored") return;
    const localX = event.nativeEvent.locationX;
    const localY = event.nativeEvent.locationY;
    const point = pagePoint(localX, localY);
    if (!point) return;
    current.last = point;
    if (current.mode === "pending") {
      const dx = localX - current.startLocalX;
      const dy = localY - current.startLocalY;
      if (Math.abs(dx) < TOUCH_SLOP_PX && Math.abs(dy) < TOUCH_SLOP_PX) return;
      // Sideways movement, or a hold before moving, selects text in the page. A quick mostly
      // vertical flick is the page scrolling under the finger instead.
      const drag =
        Math.abs(dx) > Math.abs(dy) * 1.2 || Date.now() - current.startedAt >= LONG_PRESS_MS;
      if (!drag) {
        current.mode = "scroll";
        return;
      }
      const start = current.start;
      if (!start) {
        current.mode = "ignored";
        return;
      }
      current.mode = "drag";
      current.clickCount = clickCountFor(current.startLocalX, current.startLocalY, Date.now());
      sendPointer(start, "down", current.clickCount);
      queueMove(point);
      return;
    }
    if (current.mode === "drag") queueMove(point);
  }

  function finish(event: GestureResponderEvent | null, cancelled: boolean) {
    const current = gesture.current;
    gesture.current = null;
    if (!current || current.mode === "ignored") {
      stopMove();
      return;
    }
    const released = event
      ? pagePoint(event.nativeEvent.locationX, event.nativeEvent.locationY)
      : null;
    // A release that ran off the frame still belongs to the last point inside it.
    const point = released?.inside ? released : (current.last ?? released);
    if (current.mode === "pending" && !cancelled && current.start) {
      // A tap is one press and release on the point it started on.
      const count = clickCountFor(current.startLocalX, current.startLocalY, Date.now());
      sendPointer(current.start, "down", count);
      sendPointer(current.start, "up", count);
      return;
    }
    if (current.mode === "scroll" && !cancelled && current.start && point) {
      const delta = point.y - current.start.y;
      if (Math.abs(delta) < 1) return;
      // A finger moving up brings lower content up, which is scrolling down.
      const direction = delta < 0 ? "down" : "up";
      const amount = Math.min(
        SCROLL_MAX_AMOUNT,
        Math.max(1, Math.round(Math.abs(delta) / SCROLL_PX_PER_NOTCH)),
      );
      send("scroll", { direction, amount, x: point.x, y: point.y });
      return;
    }
    if (current.mode === "drag") {
      flushPendingMove();
      const up = point ?? current.last;
      if (up) sendPointer(up, "up", current.clickCount);
      return;
    }
    stopMove();
  }

  // Created once: every handler reads the latest sizes, input and control through refs.
  const panHandlers = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => interactiveRef.current,
        onMoveShouldSetPanResponder: () => interactiveRef.current,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: grant,
        onPanResponderMove: move,
        onPanResponderRelease: (event) => finish(event, false),
        onPanResponderTerminate: () => finish(null, true),
      }).panHandlers,
    [],
  );

  function onLayout(event: LayoutChangeEvent) {
    const { width, height } = event.nativeEvent.layout;
    setLayout((current) =>
      current.width === width && current.height === height ? current : { width, height },
    );
  }

  return (
    <View
      {...panHandlers}
      onLayout={onLayout}
      testID={testID}
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      accessible={!interactive}
      style={[styles.frame, style]}
    >
      {image ? (
        <Image
          source={{ uri: image }}
          resizeMode="contain"
          pointerEvents="none"
          onLoad={(event) => {
            const { width, height } = event.nativeEvent.source;
            if (width <= 0 || height <= 0) return;
            setNatural((current) =>
              current && current.width === width && current.height === height
                ? current
                : { width, height },
            );
          }}
          style={styles.image}
        />
      ) : (
        <View style={styles.placeholder}>
          {placeholder ?? (
            <Text style={{ color: tokens.mutedForeground, textAlign: "center" }}>
              {t`Waiting for the browser…`}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1, backgroundColor: "black", overflow: "hidden" },
  image: { height: "100%", width: "100%" },
  placeholder: { alignItems: "center", flex: 1, justifyContent: "center", padding: 16 },
});
