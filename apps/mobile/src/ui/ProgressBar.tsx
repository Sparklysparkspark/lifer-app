import { View } from "react-native";
import { useTheme } from "../theme/useTheme";

/** A thin sage bar for "x of y". Fraction 0 to 1. */
export function ProgressBar({ fraction, label }: { fraction: number; label: string }) {
  const { colors } = useTheme();
  const pct = Math.max(0, Math.min(1, fraction));
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(pct * 100) }}
      style={{ height: 6, borderRadius: 3, backgroundColor: colors.fill, overflow: "hidden" }}
    >
      <View style={{ width: `${pct * 100}%`, height: 6, borderRadius: 3, backgroundColor: colors.accent }} />
    </View>
  );
}
