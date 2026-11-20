import { Text } from "react-native";
import { spacing, type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";

/** A quiet line of explanation or status (the sync line, a size, an offline note). */
export function Note({ text, padded = false }: { text: string; padded?: boolean }) {
  const { colors } = useTheme();
  return (
    <Text
      accessibilityLiveRegion="polite"
      style={{ color: colors.muted, fontSize: type.footnote.size, paddingHorizontal: padded ? spacing.page : 0 }}
    >
      {text}
    </Text>
  );
}
