import { useLingui } from "@lingui/react/macro";
import type { ComputerStatus } from "@rakazo/contracts";
import { typeScale } from "@rakazo/ui-tokens";
import { StyleSheet, Text, View } from "react-native";
import { native, useMobileTokens } from "../../lib/native/native";
import { NativeSymbol } from "../native/native-symbol";

type BrowserTab = NonNullable<ComputerStatus["browserTabs"]>[number];

/** A tab's host, or its whole URL when that URL cannot be parsed. */
function tabHost(url: string) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** The shared browser's open tabs, each labelled with the bot that opened it. */
export function BrowserTabsPanel({ tabs }: { tabs: BrowserTab[] }) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  return (
    <View
      testID="browser-tabs"
      style={[styles.panel, { borderColor: tokens.border, backgroundColor: native.fill }]}
    >
      <View style={[styles.header, { borderBottomColor: tokens.border }]}>
        <NativeSymbol
          ios="globe"
          android="globe-outline"
          size={14}
          color={tokens.mutedForeground}
        />
        <Text style={[styles.headerText, { color: tokens.mutedForeground }]}>
          {t`Shared browser`}
        </Text>
      </View>
      {tabs.map((tab, index) => (
        <View
          key={tab.id}
          testID="browser-tab-row"
          style={[
            styles.row,
            index > 0
              ? { borderTopColor: tokens.border, borderTopWidth: StyleSheet.hairlineWidth }
              : null,
          ]}
        >
          <View style={[styles.owner, { backgroundColor: tokens.background }]}>
            <Text numberOfLines={1} style={[styles.ownerText, { color: tokens.mutedForeground }]}>
              {tab.botName ?? t`Unclaimed`}
            </Text>
          </View>
          <Text numberOfLines={1} style={[styles.title, { color: tokens.foreground }]}>
            {tab.title || tab.url}
          </Text>
          <Text numberOfLines={1} style={[styles.host, { color: tokens.mutedForeground }]}>
            {tabHost(tab.url)}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  header: {
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  headerText: { ...typeScale.caption, fontWeight: "500" },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  owner: {
    borderRadius: 999,
    flexShrink: 0,
    maxWidth: "38%",
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  ownerText: typeScale.caption,
  title: { ...typeScale.body, flex: 1, minWidth: 0 },
  host: { ...typeScale.caption, flexShrink: 0, maxWidth: "38%" },
});
