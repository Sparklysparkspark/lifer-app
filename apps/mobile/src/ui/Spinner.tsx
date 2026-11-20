import { ActivityIndicator } from "react-native";
import { useTheme } from "../theme/useTheme";

export function Spinner({ label, small }: { label: string; small?: boolean }) {
  const { colors } = useTheme();
  return <ActivityIndicator accessibilityLabel={label} size={small ? "small" : "large"} color={colors.muted} />;
}
