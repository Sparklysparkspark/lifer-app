import type { ReactNode } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { spacing } from "../theme/theme";

/** The primary action in the lower third (MR2): a row floating over the content, above the home indicator. */
export function FloatingToolbar({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: spacing.gutter,
        right: spacing.gutter,
        bottom: Math.max(insets.bottom, 12),
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
      }}
    >
      {children}
    </View>
  );
}
