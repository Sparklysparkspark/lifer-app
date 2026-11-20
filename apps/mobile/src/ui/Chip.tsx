import { Platform, Text, View } from "react-native";
import { MIN_TOUCH, radius, type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";
import { Icon } from "./Icon";
import { Tap } from "./Tap";

interface Props {
  label: string;
  /** Spoken name of the remove action ("Remove filter: golden ratio"). */
  removeLabel: string;
  onRemove: () => void;
}

/** A removable token. Long text wraps onto more lines instead of being cut off. */
export function Chip({ label, removeLabel, onRemove }: Props) {
  const { colors } = useTheme();
  return (
    <Tap label={removeLabel} onPress={onRemove} style={{ flexShrink: 1 }}>
      <View
        style={{
          minHeight: MIN_TOUCH[Platform.OS === "ios" ? "ios" : "android"],
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingLeft: 14,
          paddingRight: 12,
          paddingVertical: 6,
          borderRadius: radius.control,
          backgroundColor: colors.fill,
        }}
      >
        <Text style={{ flexShrink: 1, color: colors.ink, fontSize: type.subheadline.size }}>{label}</Text>
        <Icon name="close" size={13} color={colors.muted} weight="semibold" />
      </View>
    </Tap>
  );
}
