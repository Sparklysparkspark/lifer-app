import { Text, View } from "react-native";
import { radius, type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";

/** A big plain number with what it counts. */
export function StatTile({ value, label }: { value: string; label: string }) {
  const { colors } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${value} ${label}`}
      style={{
        flex: 1,
        backgroundColor: colors.surface,
        borderRadius: radius.group,
        paddingVertical: 14,
        paddingHorizontal: 16,
        borderWidth: 1,
        borderColor: colors.hairline,
      }}
    >
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        style={{ color: colors.ink, fontSize: 30, fontWeight: "700", fontVariant: ["tabular-nums"] }}
      >
        {value}
      </Text>
      <Text style={{ color: colors.muted, fontSize: type.subheadline.size }}>{label}</Text>
    </View>
  );
}
