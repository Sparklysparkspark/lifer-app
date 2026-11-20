import { Text } from "react-native";
import { type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";

/** A title inside a page that has no navigation bar ("title"), or a section title ("section"). */
export function Heading({ text, level = "title" }: { text: string; level?: "title" | "section" }) {
  const { colors } = useTheme();
  const title = level === "title";
  return (
    <Text
      accessibilityRole="header"
      style={{ color: colors.ink, fontSize: title ? type["title-1"].size : type["title-3"].size, fontWeight: "700" }}
    >
      {text}
    </Text>
  );
}
