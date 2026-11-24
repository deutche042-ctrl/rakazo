import { errorCode } from "@rakazo/core";
import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../api/api";
import { useAppForeground } from "../platform/app-foreground";

/** A shared browser's page is a still a second, faster for a moment after someone touches it. */
export const BROWSER_PREVIEW_MS = 1_000;
export const BROWSER_PREVIEW_BURST_MS = 350;
export const BROWSER_PREVIEW_BURST_FOR_MS = 2_000;

/** The input kinds `computer/input` takes; every payload is in the page's own CSS pixels. */
export type BrowserLiveInputKind = "pointer" | "key" | "scroll" | "clipboard";
export type BrowserLiveInput = (
  kind: BrowserLiveInputKind,
  payload: Record<string, unknown>,
) => void;

/** A refused action: the server's code, or a bare proxy answer without one. */
function isForbidden(error: unknown) {
  const status =
    error && typeof error === "object" && "status" in error ? error.status : undefined;
  return errorCode(error) === "FORBIDDEN" || status === 403;
}

/**
 * The shared browser's live still, refreshed while the panel is open and the app is in front.
 * Input is sent through the same route as the full window's; a page that just took input is the
 * one worth seeing next, so the preview runs at a live pace for a moment afterwards.
 */
export function useBrowserLive({
  botId,
  enabled = true,
  interactive = false,
}: {
  botId: string | undefined;
  /** False while the panel is closed; the poll stops and input is refused. */
  enabled?: boolean;
  /** Whether control is held; each new grant starts a fresh input episode. */
  interactive?: boolean;
}) {
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const active = Boolean(botId) && enabled && focused && foreground;
  const [image, setImage] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [forbidden, setForbidden] = useState(false);
  const lastImage = useRef<string | null>(null);
  const burstUntil = useRef(0);
  const pokePreview = useRef<(() => void) | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  // A refusal belongs to the control episode that sent the input; a later grant must not keep
  // the previous episode's refusal in force.
  const forbiddenRef = useRef(false);
  forbiddenRef.current = forbidden;
  const controlEpisode = useRef(0);
  const wasInteractive = useRef(interactive);
  // One computer/input at a time, so a tap's up cannot overtake its own down.
  const inputQueue = useRef<Promise<void>>(Promise.resolve());

  // Another bot's browser must not keep showing while its own first frame is on the way.
  useEffect(() => {
    lastImage.current = null;
    setImage(null);
    setForbidden(false);
    forbiddenRef.current = false;
    controlEpisode.current += 1;
    inputQueue.current = Promise.resolve();
    wasInteractive.current = interactive;
    setRefreshKey(0);
  }, [botId]);

  // Control granted again starts a new episode, which clears an earlier refusal.
  useEffect(() => {
    const granted = interactive && !wasInteractive.current;
    wasInteractive.current = interactive;
    if (!granted) return;
    controlEpisode.current += 1;
    forbiddenRef.current = false;
    setForbidden(false);
  }, [interactive]);

  useEffect(() => {
    if (!active || !botId) return;
    let cancelled = false;
    let reading = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      if (cancelled) return;
      const burst = Date.now() < burstUntil.current;
      timer = setTimeout(() => void read(), burst ? BROWSER_PREVIEW_BURST_MS : BROWSER_PREVIEW_MS);
    };

    const read = async () => {
      if (cancelled) return;
      if (reading) {
        // A read already on its way is joined; one more follows it, so the newest frame lands.
        again = true;
        return;
      }
      reading = true;
      const sentEpisode = controlEpisode.current;
      try {
        const answer = await rpc("computer/preview", { botId });
        if (cancelled) return;
        // An unchanged frame is not worth re-decoding the data URL for.
        if (answer.image !== lastImage.current) {
          lastImage.current = answer.image;
          setImage(answer.image);
          setRefreshKey((key) => key + 1);
        }
        // Seeing the page says nothing about holding control, so a refusal stays in force.
      } catch (error) {
        if (cancelled) return;
        // A refusal from an earlier episode must not block the current one.
        if (isForbidden(error) && controlEpisode.current === sentEpisode) setForbidden(true);
      } finally {
        reading = false;
        if (cancelled) return;
        if (again) {
          again = false;
          void read();
        } else {
          schedule();
        }
      }
    };

    // Input asks for the next frame at once instead of waiting out the usual second.
    pokePreview.current = () => {
      if (cancelled) return;
      if (timer) clearTimeout(timer);
      void read();
    };
    void read();
    return () => {
      cancelled = true;
      pokePreview.current = null;
      if (timer) clearTimeout(timer);
    };
  }, [active, botId]);

  const sendInput = useCallback<BrowserLiveInput>(
    (kind, payload) => {
      if (!botId || !activeRef.current || forbiddenRef.current) return;
      // Ask for a frame now; a slow input still gets a fresh read once it lands.
      burstUntil.current = Date.now() + BROWSER_PREVIEW_BURST_FOR_MS;
      pokePreview.current?.();
      const sentEpisode = controlEpisode.current;
      // Chain each request behind the last so the browser sees the events in call order.
      inputQueue.current = inputQueue.current
        .catch(() => undefined)
        .then(async () => {
          try {
            await rpc("computer/input", { botId, kind, payload });
          } catch (error) {
            if (isForbidden(error) && controlEpisode.current === sentEpisode) setForbidden(true);
            return;
          }
          // The page has taken the input: renew the burst from when it landed.
          burstUntil.current = Date.now() + BROWSER_PREVIEW_BURST_FOR_MS;
          pokePreview.current?.();
        });
    },
    [botId],
  );

  return { image, refreshKey, sendInput, forbidden };
}
