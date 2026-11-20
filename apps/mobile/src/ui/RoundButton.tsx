import { View } from "react-native";
import { ON_BACKDROP } from "../theme/theme";
import { useTheme } from "../theme/useTheme";
import { Glass } from "./Glass";
import { Icon, type IconName } from "./Icon";
import { Tap } from "./Tap";

interface Props {
  icon: IconName;
  label: string;
  onPress?: () => void;
  size?: number;
  /** Over a photo: dark glass and white symbol. */
  onPhoto?: boolean;
  disabled?: boolean;
}

/** A round glass button: the platform's bar button look for our own chrome (viewer, species page). */
export function RoundButton({ icon, label, onPress, size = 44, onPhoto, disabled }: Props) {
  const { colors } = useTheme();
  return (
    <Tap label={label} onPress={onPress} disabled={disabled}>
      <Glass
        interactive
        onPhoto={onPhoto}
        style={{ width: size, height: size, borderRadius: size / 2, overflow: "hidden" }}
      >
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <Icon name={icon} size={Math.round(size * 0.42)} color={onPhoto ? ON_BACKDROP : colors.ink} />
        </View>
      </Glass>
    </Tap>
  );
}

/** Round buttons side by side in one capsule, as iOS 26 groups adjacent bar buttons. */
export function RoundCapsule({
  items,
  onPhoto,
  size = 44,
}: {
  items: { icon: IconName; label: string; onPress: () => void; active?: boolean }[];
  onPhoto?: boolean;
  size?: number;
}) {
  const { colors } = useTheme();
  return (
    <Glass onPhoto={onPhoto} style={{ height: size, borderRadius: size / 2, overflow: "hidden", flexDirection: "row" }}>
      {items.map((i) => (
        <Tap key={i.label} label={i.label} onPress={i.onPress}>
          <View style={{ width: size + 2, height: size, alignItems: "center", justifyContent: "center" }}>
            <Icon
              name={i.icon}
              size={Math.round(size * 0.42)}
              color={onPhoto ? ON_BACKDROP : i.active ? colors.link : colors.ink}
            />
          </View>
        </Tap>
      ))}
    </Glass>
  );
}
