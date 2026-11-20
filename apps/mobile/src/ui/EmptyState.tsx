import { Text, View } from "react-native";
import { spacing, type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";
import { Button } from "./Button";
import { Icon, type IconName } from "./Icon";

interface Props {
  icon?: IconName;
  /** One line: what is empty. */
  title: string;
  /** One line: why, or what to do. */
  line?: string;
  action?: { label: string; onPress: () => void };
}

/** The shared empty state: symbol, title, one line of why, one button for the next step. */
export function EmptyState({ icon, title, line, action }: Props) {
  const { colors } = useTheme();
  return (
    <View style={{ alignItems: "center", justifyContent: "center", padding: spacing.page * 1.5, gap: 8 }}>
      {icon ? <Icon name={icon} size={40} color={colors.muted} weight="regular" /> : null}
      <Text
        accessibilityRole="header"
        style={{ color: colors.ink, fontSize: type["title-3"].size, fontWeight: "600", textAlign: "center" }}
      >
        {title}
      </Text>
      {line ? <Text style={{ color: colors.muted, fontSize: type.body.size, textAlign: "center" }}>{line}</Text> : null}
      {action ? (
        <View style={{ paddingTop: 12 }}>
          <Button label={action.label} onPress={action.onPress} compact />
        </View>
      ) : null}
    </View>
  );
}
