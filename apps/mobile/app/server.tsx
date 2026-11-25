import { useLingui } from "@lingui/react/macro";
import type { ModelHeaderRow } from "@rakazo/contracts";
import { serverHeadersFromRows } from "@rakazo/contracts";
import * as Clipboard from "expo-clipboard";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Share,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { HeaderRowsEditor } from "../components/integrations/header-rows-editor";
import { NativeActionButton } from "../components/native/native-action-button";
import { NativeSymbol } from "../components/native/native-symbol";
import { cancelHeaderOptions, trailingHeaderOptions } from "../components/native/sheet-header";
import { SettingsGroup, SettingsRow } from "../components/settings/settings-group";
import { LongPressMenu } from "../components/ui/long-press-menu";
import { authHeaders, currentApiBase } from "../lib/api/api";
import { resetApiBase, saveApiBase } from "../lib/api/api-server";
import {
  apiBaseWarning,
  defaultApiBase,
  displaySavedServer,
  normalizeApiBase,
  probeApiBase,
  usesCustomApiBase,
} from "../lib/api/endpoint";
import {
  formatUptime,
  LIVE_LINK_REFRESH_MS,
  liveLinkHost,
  liveLinkTone,
  readLiveLink,
} from "../lib/api/live-link";
import type { SavedServer } from "../lib/api/saved-servers";
import { removeSavedServer, savedServers } from "../lib/api/saved-servers";
import { serverHeaders } from "../lib/api/server-headers";
import { errorText } from "../lib/api/user-error";
import { CallKeyboardContext } from "../lib/calls/call-keyboard-context";
import { useSideInsets } from "../lib/layout/side-insets";
import { announceToScreenReader } from "../lib/native/announce";
import { useMobileTokens, useResolvedAppearance } from "../lib/native/native";
import { useForegroundPoll } from "../lib/query/foreground-poll";
import { useScreenQuery } from "../lib/query/screen-query";
import { confirmUnsentSendLoss } from "../lib/thread/send/unsent-send-warning";

export default function ServerScreen() {
  const call = useContext(CallKeyboardContext);
  const sideInsets = useSideInsets();
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const router = useRouter();
  const current = currentApiBase();
  const [draft, setDraft] = useState(current);
  const [headerRows, setHeaderRows] = useState<ModelHeaderRow[]>(() =>
    Object.entries(serverHeaders(current)).map(([name, value]) => ({ name, value })),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(savedServers);
  const [onScreen, setOnScreen] = useState(false);
  const [liveLinkNote, setLiveLinkNote] = useState<string | null>(null);
  const colorScheme = useResolvedAppearance();
  const active = useRef(true);
  const saving = useRef(false);
  const removing = useRef(new Set<string>());

  useEffect(() => {
    return () => {
      active.current = false;
    };
  }, []);

  // The live link is read while this screen is on top. Leaving it disables the query and stops
  // the poll, so a phone in a pocket does not keep asking the server about its tunnel.
  useFocusEffect(
    useCallback(() => {
      setOnScreen(true);
      setLiveLinkNote(null);
      return () => setOnScreen(false);
    }, []),
  );

  const liveLink = useScreenQuery(
    {
      queryKey: ["live-link", current],
      queryFn: async ({ signal }) => {
        const headers = { ...serverHeaders(current), ...(await authHeaders()) };
        return readLiveLink({ base: current, headers, signal });
      },
    },
    { enabled: onScreen },
  );
  // One poll at a time, only while the screen and the app are both visible.
  useForegroundPoll(
    () => liveLink.refetch({ cancelRefetch: false }),
    LIVE_LINK_REFRESH_MS,
    onScreen,
  );

  async function copyLiveLink(url: string) {
    try {
      await Clipboard.setStringAsync(url);
      const message = t`Link copied`;
      setLiveLinkNote(message);
      announceToScreenReader(message);
    } catch {
      const message = t`Could not copy the link`;
      setLiveLinkNote(message);
      announceToScreenReader(message);
    }
  }

  async function shareLiveLink(url: string) {
    // A dismissed share sheet resolves without sharing, and is not an error worth a message.
    await Share.share({ message: url }).catch(() => undefined);
  }

  function close() {
    if (!active.current) return;
    active.current = false;
    if (router.canGoBack()) router.back();
    else router.replace("/sign-in");
  }

  // Save keeps focus while the check runs, so each failure is spoken as well as shown.
  function fail(message: string) {
    setError(message);
    announceToScreenReader(message);
  }

  const parsedDraft = normalizeApiBase(draft);
  const warning = parsedDraft.ok ? apiBaseWarning(parsedDraft.url) : null;

  // The same four states and lamp colors as Settings > Live link on the web. The phone shows the
  // link, copies it and shares it; stopping the tunnel and reading its log stay on the machine.
  const liveView = liveLink.data ?? null;
  const liveLabel = !liveView
    ? ""
    : liveView.state === "running"
      ? t`Running`
      : liveView.state === "error"
        ? t`Problem`
        : liveView.state === "stopped"
          ? t`Stopped`
          : t`Off`;
  const liveTone = liveView ? liveLinkTone(liveView.state) : null;
  const liveColor =
    liveTone === "success"
      ? tokens.success
      : liveTone === "warning"
        ? tokens.warning
        : tokens.destructive;
  const liveTitle =
    liveView?.state === "running" && liveView.uptimeSeconds !== null
      ? `${liveLabel} · ${formatUptime(liveView.uptimeSeconds)}`
      : liveLabel;
  const liveHost = liveView ? liveLinkHost(liveView.url) : null;
  const liveDetail = !liveView
    ? undefined
    : liveView.state === "running"
      ? (liveView.url ?? undefined)
      : liveView.state === "error"
        ? (liveView.lastError ?? t`The tunnel is not running.`)
        : t`Start it with bash scripts/native/tunnel.sh.`;

  // A saved server brings the headers it was set up with; typing an address uses the rows.
  async function save(target?: SavedServer) {
    // A switch to a server whose removal is still running would list it again once it lands.
    if (saving.current || (target && removing.current.has(target.apiBase))) return;
    // Held across the confirmation, so a second submit cannot start a parallel switch.
    saving.current = true;
    try {
      setPending(true);
      setError(null);
      let headers: Record<string, string>;
      try {
        headers = target ? target.headers : serverHeadersFromRows(headerRows);
      } catch (headerError) {
        fail(errorText(headerError));
        return;
      }
      const probed = await probeApiBase(target ? target.apiBase : draft, fetch, headers);
      if (!active.current) return;
      if (!probed.ok) {
        fail(probed.error);
        return;
      }
      // Asked once the switch can happen. Only a different server clears the device; the same
      // address saves without a switch.
      if (probed.url !== current && !(await confirmUnsentSendLoss("server-switch"))) return;
      if (!active.current) return;
      const saved = await saveApiBase(probed.url, headers);
      if (!saved.ok) {
        fail(saved.error);
        return;
      }
      close();
    } finally {
      saving.current = false;
      setPending(false);
    }
  }

  async function forget(apiBase: string) {
    // A switch in progress records its server when it lands, which would bring this one back.
    if (saving.current) return;
    if (removing.current.has(apiBase)) return;
    removing.current.add(apiBase);
    try {
      if (!(await removeSavedServer(apiBase))) {
        if (active.current) fail(t`Could not remove the server`);
        return;
      }
      if (active.current) {
        setError(null);
        setSaved(savedServers());
      }
    } finally {
      removing.current.delete(apiBase);
    }
  }

  async function restoreDefault() {
    if (saving.current) return;
    // Held across the confirmation, like save, so the two cannot run a switch in parallel.
    saving.current = true;
    try {
      if (usesCustomApiBase(current) && !(await confirmUnsentSendLoss("server-switch"))) return;
      setPending(true);
      setError(null);
      const saved = await resetApiBase();
      if (!active.current) return;
      if (!saved.ok) {
        fail(saved.error);
        return;
      }
      close();
    } finally {
      saving.current = false;
      setPending(false);
    }
  }

  return (
    <SafeAreaView edges={["bottom"]} style={{ flex: 1, backgroundColor: tokens.background }}>
      <Stack.Screen
        options={{
          title: t`Server`,
          ...cancelHeaderOptions(t`Cancel`, close),
          ...trailingHeaderOptions(pending ? t`Checking…` : t`Save`, () => void save(), pending),
        }}
      />
      <KeyboardAvoidingView
        enabled={!call}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          style={sideInsets}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 12, paddingBottom: 24 }}
          keyboardShouldPersistTaps="handled"
        >
          <TextInput
            testID="server-address"
            accessibilityLabel={t`Server`}
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect={false}
            editable={!pending}
            keyboardType="url"
            onChangeText={(value) => {
              setDraft(value);
              setError(null);
            }}
            onSubmitEditing={() => void save()}
            placeholder={defaultApiBase()}
            placeholderTextColor={tokens.mutedForeground}
            returnKeyType="go"
            style={{
              backgroundColor: tokens.muted,
              borderRadius: 13,
              padding: 16,
              color: tokens.foreground,
              fontSize: 16,
            }}
            textContentType="URL"
            value={draft}
          />
          {warning ? (
            <Text style={{ color: tokens.mutedForeground, marginTop: 12, fontSize: 13 }}>
              {warning}
            </Text>
          ) : null}
          <HeaderRowsEditor
            rows={headerRows}
            onChange={(rows) => {
              setHeaderRows(rows);
              setError(null);
            }}
            disabled={pending}
          />
          {error ? (
            <Text accessibilityRole="alert" style={{ color: tokens.destructive, marginTop: 12 }}>
              {error}
            </Text>
          ) : null}
          {liveView ? (
            <SettingsGroup
              label={t`Live link`}
              footer={
                liveView.state === "running"
                  ? t`Anyone who has the link can open this server.`
                  : undefined
              }
            >
              <SettingsRow
                accessible
                accessibilityLabel={t`Live link`}
                accessibilityValue={{ text: liveTitle }}
                title={liveTitle}
                detail={liveDetail}
                value={liveHost ?? undefined}
                leading={
                  <View
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 5,
                      backgroundColor: liveColor,
                    }}
                  />
                }
              />
              {liveView.url ? (
                <SettingsRow
                  accessibilityRole="button"
                  title={t`Copy link`}
                  leading={
                    <NativeSymbol
                      ios="doc.on.doc"
                      android="copy-outline"
                      color={tokens.mutedForeground}
                    />
                  }
                  onPress={() => {
                    const link = liveView.url;
                    if (link) void copyLiveLink(link);
                  }}
                />
              ) : null}
              {liveView.url ? (
                <SettingsRow
                  accessibilityRole="button"
                  title={t`Share link`}
                  leading={
                    <NativeSymbol
                      ios="square.and.arrow.up"
                      android="share-social-outline"
                      color={tokens.mutedForeground}
                    />
                  }
                  onPress={() => {
                    const link = liveView.url;
                    if (link) void shareLiveLink(link);
                  }}
                />
              ) : null}
            </SettingsGroup>
          ) : null}
          {liveLinkNote ? (
            <Text
              style={{
                color: tokens.mutedForeground,
                marginTop: 8,
                paddingHorizontal: 16,
                fontSize: 13,
              }}
            >
              {liveLinkNote}
            </Text>
          ) : null}
          <SettingsGroup label={t`Recent servers`}>
            {saved
              .filter((entry) => entry.apiBase !== current)
              .map((entry) => (
                <LongPressMenu
                  key={entry.apiBase}
                  colorScheme={colorScheme}
                  title={displaySavedServer(entry.apiBase)}
                  actions={[{ id: "remove", title: t`Remove`, attributes: { destructive: true } }]}
                  onPressAction={() => void forget(entry.apiBase)}
                >
                  {(onLongPress) => (
                    <SettingsRow
                      accessibilityRole="button"
                      title={displaySavedServer(entry.apiBase)}
                      disabled={pending}
                      dimmed={pending}
                      onPress={() => void save(entry)}
                      onLongPress={onLongPress}
                    />
                  )}
                </LongPressMenu>
              ))}
          </SettingsGroup>
          {usesCustomApiBase(current) || draft.trim() !== current ? (
            <NativeActionButton
              disabled={pending}
              label={t`Use default server`}
              onPress={() => void restoreDefault()}
              prominence="plain"
              style={{ marginTop: 28, alignSelf: "center" }}
            />
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
