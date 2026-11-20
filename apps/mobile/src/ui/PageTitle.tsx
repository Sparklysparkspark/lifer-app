import { Text } from "react-native";
import { spacing, type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";

/** The large title of a pushed page whose name can be long (an album or a trip): it wraps in full, where the native large title would cut it. */
export function PageTitle({ text }: { text: string }) {
  const { colors } = useTheme();
  return (
    <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: type["large-title"].size, fontWeight: "700", paddingHorizontal: spacing.page, paddingTop: 8, paddingBottom: 6 }}>
      {text}
    </Text>
  );
}
