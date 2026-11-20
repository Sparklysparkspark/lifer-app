import { ActivityIndicator, Platform, Text, View } from "react-native";
import { MIN_TOUCH, radius, spacing, type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";
import { Icon, type IconName } from "./Icon";
import { Tap } from "./Tap";

interface Props {
  label: string;
  onPress: () => void;
  /** Primary is the one main action of a screen; secondary sits beside it; plain is a text link. */
  variant?: "primary" | "secondary" | "plain";
  icon?: IconName;
  busy?: boolean;
  disabled?: boolean;
  /** Fills the space beside another button. */
  grow?: number;
  compact?: boolean;
}

/** A capsule button. Grows with Dynamic Type instead of clipping its label. */
export function Button({ label, onPress, variant = "primary", icon, busy, disabled, grow, compact }: Props) {
  const { colors, appearance } = useTheme();
  const primary = variant === "primary";
  const plain = variant === "plain";
  const ink = primary ? colors["accent-fg"] : plain ? colors.link : colors.ink;
  return (
    <Tap
      label={label}
      onPress={onPress}
      disabled={disabled || busy}
      style={{ flexGrow: grow ?? 0, flexShrink: 1, flexBasis: grow ? 0 : undefined }}
    >
      <View
        style={{
          minHeight: Math.max(compact ? 44 : 50, MIN_TOUCH[Platform.OS === "ios" ? "ios" : "android"]),
          paddingHorizontal: spacing.item,
          paddingVertical: 10,
          borderRadius: radius.control,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          backgroundColor: primary ? colors.accent : plain ? "transparent" : colors.fill,
          borderWidth: variant === "secondary" && appearance === "sunlight" ? 1 : 0,
          borderColor: colors["control-line"],
        }}
      >
        {busy ? (
          <ActivityIndicator color={ink} />
        ) : icon ? (
          <Icon name={icon} size={20} color={ink} weight="semibold" />
        ) : null}
        <Text
          style={{ color: ink, fontSize: type.headline.size, fontWeight: "600", flexShrink: 1, textAlign: "center" }}
        >
          {label}
        </Text>
      </View>
    </Tap>
  );
}
