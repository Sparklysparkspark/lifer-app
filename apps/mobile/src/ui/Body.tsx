import { Text } from "react-native";
import { type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";

/** Ordinary reading text in the theme's ink. */
export function Body({ text }: { text: string }) {
  const { colors } = useTheme();
  return <Text style={{ color: colors.ink, fontSize: type.body.size }}>{text}</Text>;
}
