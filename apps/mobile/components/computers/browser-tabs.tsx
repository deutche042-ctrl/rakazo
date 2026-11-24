import { useLingui } from "@lingui/react/macro";
import type { ComputerStatus } from "@rakazo/contracts";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useMobileTokens } from "../../lib/native/native";
import { NativeSymbol } from "../native/native-symbol";

type BrowserTabList = NonNullable<ComputerStatus["browserTabs"]>;

/** A tab with no title shows only its host: never its path, query, fragment or sign-in. */
function tabTitle(tab: { title: string; url: string }, untitled: string) {
  if (tab.title) return tab.title;
  try {
    return new URL(tab.url).host || untitled;
  } catch {
    return untitled;
  }
}

/**
 * The shared browser's open tabs, each labelled with the bot that opened it. Mobile only shows
 * them: focusing a tab is a desktop convenience the small screen does not need.
 */
export function BrowserTabs({
  tabs,
  botId,
}: {
  tabs: BrowserTabList | undefined;
  /** The bot whose computer is open; its own tab is the one marked. */
  botId: string | undefined;
}) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  if (!tabs?.length) return null;
  return (
    <View testID="browser-tabs" style={styles.panel}>
      <View style={styles.heading}>
        <NativeSymbol
          ios="globe"
          android="globe-outline"
          size={13}
          color={tokens.mutedForeground}
        />
        <Text style={[styles.headingText, { color: tokens.mutedForeground }]}>
          {t`Shared browser`}
        </Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}
      >
        {tabs.map((tab) => {
          const own = Boolean(botId) && tab.botId === botId;
          const title = tabTitle(tab, t`Untitled`);
          const botName = tab.botName || t`Unclaimed`;
          const label = own
            ? `${botName}, ${title}, ${t`This bot’s tab`}`
            : `${botName}, ${title}`;
          return (
            <View
              key={tab.id}
              accessible
              accessibilityLabel={label}
              style={[
                styles.chip,
                {
                  borderColor: own ? tokens.foreground : tokens.border,
                  backgroundColor: own ? tokens.card : "transparent",
                },
              ]}
            >
              <Text
                numberOfLines={1}
                style={[
                  styles.botName,
                  { color: own ? tokens.foreground : tokens.mutedForeground },
                ]}
              >
                {botName}
              </Text>
              <Text
                numberOfLines={1}
                style={[styles.title, { color: tokens.foreground }]}
              >
                {title}
              </Text>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: 6 },
  heading: { alignItems: "center", flexDirection: "row", gap: 6, paddingHorizontal: 2 },
  headingText: { fontSize: 12, fontWeight: "600" },
  chips: { gap: 8, paddingHorizontal: 2 },
  chip: {
    alignItems: "center",
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 6,
    maxWidth: 260,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  botName: { fontSize: 12, fontWeight: "600", maxWidth: 96 },
  title: { flexShrink: 1, fontSize: 12 },
});
