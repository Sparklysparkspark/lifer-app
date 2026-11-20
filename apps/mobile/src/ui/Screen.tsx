import type { ReactNode } from "react";
import { KeyboardAvoidingView, Platform, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme/useTheme";
import { usePullRefresh } from "./usePullRefresh";

interface Props {
  children: ReactNode;
  /** Pull to refresh (a sync). */
  onRefresh?: () => void;
  refreshing?: boolean;
  /** True for a page with no navigation bar of its own: clears the status bar and notch. */
  safeTop?: boolean;
  /** Content padding; default 16 around and a gap between blocks. */
  padded?: boolean;
  /** False for a page whose first block runs under the navigation bar (a photo). */
  inset?: boolean;
}

/** A scrolling page that respects safe areas and the keyboard (MR13) and grows with Dynamic Type. The navigator owns the title. */
export function Screen({
  children,
  onRefresh,
  refreshing = false,
  safeTop = false,
  padded = true,
  inset = true,
}: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const pull = usePullRefresh(onRefresh, refreshing);
  const scroll = (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.canvas }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      automaticallyAdjustKeyboardInsets
      contentInsetAdjustmentBehavior={inset && !safeTop ? "automatic" : "never"}
      refreshControl={
        pull.onRefresh ? <RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} /> : undefined
      }
      contentContainerStyle={{
        flexGrow: 1,
        paddingTop: safeTop ? insets.top + 8 : 0,
        paddingBottom: Math.max(insets.bottom, 16) + 8,
      }}
    >
      {padded ? (
        <View style={{ gap: 16, paddingHorizontal: 20, paddingTop: 8, flexGrow: 1 }}>{children}</View>
      ) : (
        children
      )}
    </ScrollView>
  );
  // The scroll view must be the screen's own root on iOS: react-native-screens only sizes a form sheet's scroll
  // view when it is a direct child, and otherwise resets its frame on every scroll tick, blanking the sheet.
  if (Platform.OS === "ios") return scroll;
  return <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.canvas }}>{scroll}</KeyboardAvoidingView>;
}
