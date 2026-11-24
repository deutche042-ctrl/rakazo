import { useLingui } from "@lingui/react/macro";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TextInputInstance } from "react-native";
import { ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { computerKeyboardChanges } from "../../lib/computers/computer-keyboard";
import type { BrowserLiveInput } from "../../lib/computers/use-browser-live";
import { useMobileTokens, useResolvedAppearance } from "../../lib/native/native";
import { NativeActionButton } from "../native/native-action-button";

// Some Android keyboards report a Backspace key press just after the change that deleted with it.
const DELETE_KEY_PRESS_MS = 50;

/**
 * The few keys a page needs that a phone keyboard cannot send, plus a field that turns what is
 * typed into page input: a single character goes as a key, a paste or an input method's commit
 * goes as one clipboard write.
 */
export function BrowserKeyBar({
  active,
  onInput,
  insetBottom = false,
}: {
  /** Whether control is held; without it nothing may be sent. */
  active: boolean;
  onInput: BrowserLiveInput;
  /** True when the bar is pinned to the screen's bottom edge and must clear the home indicator. */
  insetBottom?: boolean;
}) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const appearance = useResolvedAppearance();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const inputRef = useRef<TextInputInstance>(null);
  // The field's text as last handled, updated at once. A keystroke can be reported twice before
  // React re-renders; measured from here, the repeat finds nothing new to send.
  const handled = useRef("");
  const deletedAt = useRef<number | null>(null);
  const backspacePressed = useRef(false);
  // On from the keyboard toggle until an explicit close; while on, a blur gives focus back.
  const keepOpen = useRef(false);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(
    () => () => {
      keepOpen.current = false;
    },
    [],
  );

  useLayoutEffect(() => {
    if (active) return;
    keepOpen.current = false;
    inputRef.current?.blur();
  }, [active]);

  function send(changes: { backspaces: number; text: string }) {
    if (!active) return;
    for (let count = 0; count < changes.backspaces; count += 1) {
      onInput("key", { key: "Backspace" });
    }
    if (!changes.text) return;
    // A newline is the Return key, including when an input method or a paste commits it.
    if (changes.text === "\r" || changes.text === "\n") {
      onInput("key", { key: "Enter" });
      return;
    }
    // Several characters at once are a paste or an input method's commit, not typing. A
    // character outside the BMP is two UTF-16 units, so it goes the same way.
    if (changes.text.length > 1) onInput("clipboard", { text: changes.text });
    else onInput("key", { key: changes.text });
  }

  function onChangeText(next: string) {
    const changes = computerKeyboardChanges(handled.current, next);
    handled.current = next;
    setText(next);
    if (changes.backspaces > 0) {
      deletedAt.current = backspacePressed.current ? null : Date.now();
    }
    backspacePressed.current = false;
    send(changes);
  }

  // An empty field reports no change for Backspace, so its key press is the only signal there.
  // With text, the change carries the deletion, whichever of the two arrives first.
  function onKeyPress(key: string) {
    if (!active || key !== "Backspace") return;
    const deleted = deletedAt.current;
    deletedAt.current = null;
    if (deleted !== null && Date.now() - deleted < DELETE_KEY_PRESS_MS) return;
    if (handled.current) {
      backspacePressed.current = true;
      return;
    }
    onInput("key", { key: "Backspace" });
  }

  // Edits only count at the end, where the remote caret is, so a caret moved by a tap goes back.
  function onSelectionChange(start: number, end: number) {
    const length = handled.current.length;
    if (start < length || end < length) inputRef.current?.setSelection(length, length);
  }

  function onBlur() {
    if (keepOpen.current) {
      inputRef.current?.focus();
      return;
    }
    setOpen(false);
  }

  function toggle() {
    if (!active) return;
    if (open) {
      keepOpen.current = false;
      inputRef.current?.blur();
      return;
    }
    keepOpen.current = true;
    inputRef.current?.focus();
  }

  function press(key: string) {
    if (!active) return;
    onInput("key", { key });
  }

  const keys: Array<{ key: string; label: string; accessibilityLabel: string; wide?: boolean }> = [
    { key: "Enter", label: t`Enter`, accessibilityLabel: t`Enter` },
    { key: "Backspace", label: t`Backspace`, accessibilityLabel: t`Backspace`, wide: true },
    { key: "Tab", label: t`Tab`, accessibilityLabel: t`Tab` },
    { key: "ArrowLeft", label: "←", accessibilityLabel: t`Left` },
    { key: "ArrowUp", label: "↑", accessibilityLabel: t`Up` },
    { key: "ArrowDown", label: "↓", accessibilityLabel: t`Down` },
    { key: "ArrowRight", label: "→", accessibilityLabel: t`Right` },
    { key: "Escape", label: t`Escape`, accessibilityLabel: t`Escape` },
    { key: " ", label: t`Space`, accessibilityLabel: t`Space`, wide: true },
  ];

  return (
    <View
      style={[
        styles.bar,
        {
          borderTopColor: tokens.border,
          backgroundColor: tokens.background,
          paddingBottom:
            keyboardVisible || !insetBottom ? 8 : Math.max(insets.bottom, 8),
        },
      ]}
    >
      <TextInput
        ref={inputRef}
        value={text}
        onChangeText={onChangeText}
        onKeyPress={(event) => onKeyPress(event.nativeEvent.key)}
        onSelectionChange={(event) =>
          onSelectionChange(event.nativeEvent.selection.start, event.nativeEvent.selection.end)
        }
        onFocus={() => setOpen(true)}
        onBlur={onBlur}
        onSubmitEditing={() => press("Enter")}
        submitBehavior="submit"
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        // Landscape IMEs otherwise take the whole screen with an extract field, hiding the page.
        disableFullscreenUI
        keyboardAppearance={appearance}
        accessibilityLabel={t`Computer keyboard`}
        style={styles.input}
      />
      <NativeActionButton
        accessibilityLabel={open ? t`Hide keyboard` : t`Show keyboard`}
        icon={{ ios: "keyboard", android: "keypad-outline" }}
        size="compact"
        prominence="secondary"
        fill
        selected={open}
        onPress={toggle}
        style={styles.toggle}
      />
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.keys}
        style={styles.keyScroll}
      >
        {keys.map((key) => (
          <NativeActionButton
            key={key.key}
            label={key.label}
            accessibilityLabel={key.accessibilityLabel}
            size="compact"
            prominence="secondary"
            fill
            disabled={!active}
            onPress={() => press(key.key)}
            style={key.wide ? styles.wideKey : styles.key}
          />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    alignItems: "center",
    borderTopWidth: 1,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 8,
    paddingTop: 8,
  },
  input: {
    bottom: 0,
    height: 1,
    left: 0,
    opacity: 0.02,
    position: "absolute",
    width: 1,
  },
  toggle: { width: 40 },
  keyScroll: { flex: 1 },
  keys: { gap: 6 },
  key: { minWidth: 40 },
  wideKey: { minWidth: 58 },
});
