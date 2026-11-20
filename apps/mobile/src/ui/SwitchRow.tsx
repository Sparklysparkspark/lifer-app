import { Platform, Switch, Text, View } from "react-native";
import { MIN_TOUCH, spacing, type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";

interface Props {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  /** Set by InsetGroup. */
  separator?: boolean;
}

/** A label with a switch, as a row of an InsetGroup. */
export function SwitchRow({ label, hint, value, onChange, separator }: Props) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        minHeight: Math.max(52, MIN_TOUCH[Platform.OS === "ios" ? "ios" : "android"]),
        paddingHorizontal: spacing.item,
        paddingVertical: 8,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
      }}
    >
      {separator ? (
        <View
          style={{ position: "absolute", top: 0, right: 0, left: spacing.item, height: 1, backgroundColor: colors.sep }}
        />
      ) : null}
      <View style={{ flex: 1 }}>
        <Text style={{ color: colors.ink, fontSize: type.body.size }}>{label}</Text>
        {hint ? <Text style={{ color: colors.muted, fontSize: type.footnote.size }}>{hint}</Text> : null}
      </View>
      <Switch
        accessibilityLabel={label}
        value={value}
        onValueChange={onChange}
        trackColor={{ true: colors.accent, false: colors["control-line"] }}
      />
    </View>
  );
}
