import { Text, View } from "react-native";
import { radius, spacing, type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";
import { Button } from "./Button";

/** An error in place, in plain words, with the next step (S1). Announced to screen readers. */
export function InlineError({ message, retry }: { message: string; retry?: { label: string; onPress: () => void } }) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={{ padding: spacing.item, borderRadius: radius.cover, backgroundColor: colors.fill, gap: 8 }}
    >
      <Text style={{ color: colors.ink, fontSize: type.body.size }}>{message}</Text>
      {retry ? <Button variant="secondary" compact label={retry.label} onPress={retry.onPress} /> : null}
    </View>
  );
}
