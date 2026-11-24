import { useLingui } from "@lingui/react/macro";
import type { ComputerStatus } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { StyleSheet, Text, View } from "react-native";
import { useBrowserLive } from "../../lib/computers/use-browser-live";
import { useMobileTokens } from "../../lib/native/native";
import { BrowserKeyBar } from "./browser-key-bar";
import { BrowserLiveFrame } from "./browser-live-frame";
import { BrowserTabs } from "./browser-tabs";

/**
 * The shared browser as one panel: its open tabs, the live still, and (only while this person
 * holds control) the keys. A refused input hides the keys again and asks the screen to re-read
 * the status, which turns the panel back into Take control.
 */
export function BrowserLivePanel({
  botId,
  enabled = true,
  interactive = false,
  tabs,
  onForbidden,
  placeholder,
  insetBottom = false,
  style,
  frameStyle,
  testID,
}: {
  botId: string | undefined;
  /** False while the panel is not on screen; polling pauses and input is refused. */
  enabled?: boolean;
  /** Whether this person holds the browser's control right now. */
  interactive?: boolean;
  tabs: ComputerStatus["browserTabs"];
  /** A FORBIDDEN answer means the control is gone; the screen re-reads its status. */
  onForbidden?: () => void;
  placeholder?: ReactNode;
  /** True when the key bar sits on the window's bottom edge and must clear the home indicator. */
  insetBottom?: boolean;
  style?: StyleProp<ViewStyle>;
  frameStyle?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const live = useBrowserLive({ botId, enabled, interactive });
  const notified = useRef(false);
  useEffect(() => {
    if (live.forbidden) {
      if (!notified.current) {
        notified.current = true;
        onForbidden?.();
      }
      return;
    }
    notified.current = false;
  }, [live.forbidden, onForbidden]);
  const canInput = interactive && !live.forbidden && enabled;
  return (
    <View style={[styles.panel, style]}>
      <BrowserTabs tabs={tabs} botId={botId} />
      <View style={[styles.frame, frameStyle]}>
        <BrowserLiveFrame
          image={live.image}
          interactive={canInput}
          onInput={live.sendInput}
          placeholder={placeholder}
          accessibilityLabel={t`Bot browser`}
          testID={testID}
        />
      </View>
      {live.forbidden ? (
        <Text style={[styles.notice, { color: tokens.mutedForeground }]}>
          {t`Take control to use the browser`}
        </Text>
      ) : null}
      {canInput ? (
        <BrowserKeyBar active insetBottom={insetBottom} onInput={live.sendInput} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: 8 },
  frame: { borderRadius: 12, minHeight: 120, overflow: "hidden", width: "100%" },
  notice: { fontSize: 12, paddingHorizontal: 2 },
});
