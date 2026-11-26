// The one way a rarity tier is shown, as the desktop's TierLabel: a quiet pill in sentence case, the same
// for every tier. Cards, rows and the species page all use it so a tier never changes shape.
import { Text, View } from "react-native";
import type { Pill } from "../collection/tiers";
import { type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";

export function TierLabel({ pill }: { pill: Pill }) {
  const { colors } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={pill.label}
      style={{
        maxWidth: "100%",
        borderRadius: 6,
        paddingHorizontal: 6,
        paddingVertical: 2,
        backgroundColor: colors["surface-muted"],
      }}
    >
      <Text style={{ color: colors.muted, fontSize: type.footnote.size }}>{pill.text}</Text>
    </View>
  );
}

/** Pills that wrap: side by side when they fit, one under the other on a narrow card or at large text. */
export function TierPills({ pills, gap = 4 }: { pills: Pill[]; gap?: number }) {
  if (!pills.length) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", gap }}>
      {pills.map((p) => (
        <TierLabel key={p.text} pill={p} />
      ))}
    </View>
  );
}
