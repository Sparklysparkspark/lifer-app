import type { ReactNode } from "react";
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { BACKDROP_GLASS } from "../theme/theme";
import { useTheme } from "../theme/useTheme";

interface Props {
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
  /** Dark glass over a photo, whatever the appearance. */
  onPhoto?: boolean;
  interactive?: boolean;
}

/**
 * The platform's glass material on iOS 26, for pieces we float ourselves (species toolbar, trip accessory, badges).
 * Elsewhere, and in Sunlight, a translucent solid surface: no blur, no transparency games in the sun.
 */
export function Glass({ style, children, onPhoto, interactive }: Props) {
  const { colors, appearance } = useTheme();
  if (appearance !== "sunlight" && Platform.OS === "ios" && isLiquidGlassAvailable()) {
    return (
      <GlassView
        glassEffectStyle="regular"
        isInteractive={interactive}
        colorScheme={onPhoto ? "dark" : appearance === "dark" ? "dark" : "light"}
        style={style}
      >
        {children}
      </GlassView>
    );
  }
  return (
    <View
      style={[
        {
          backgroundColor: onPhoto ? BACKDROP_GLASS : colors.glass,
          borderColor: colors.hairline,
          borderWidth: StyleSheet.hairlineWidth,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
