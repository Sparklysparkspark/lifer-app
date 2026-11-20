import { Platform, View } from "react-native";
import { MIN_TOUCH } from "../theme/theme";
import { useTheme } from "../theme/useTheme";
import { CroppedImage } from "./CroppedImage";
import { Tap } from "./Tap";
import type { Crop } from "../photos/crop";

interface Props {
  /** A local file path or URL; null shows a quiet placeholder while the copy is on its way. */
  uri: string | null;
  size: number;
  /** For tiles that keep their shape: the width, when it is not the size. */
  width?: number;
  label: string;
  onPress?: () => void;
  rounded?: boolean;
  /** The user's chosen crop, for a square tile; other shapes centre. */
  crop?: Crop | null;
  /** Very small tiles (12 or 16 across): no minimum size, a hairline gap, no touch target of their own. */
  dense?: boolean;
}

/** A photo tile. The whole tile is the target, never smaller than the minimum (MR1). */
export function PhotoTile({ uri, size, width, label, onPress, rounded, crop, dense }: Props) {
  const { colors } = useTheme();
  const min = MIN_TOUCH[Platform.OS === "ios" ? "ios" : "android"];
  const w = dense ? (width ?? size) : Math.max(width ?? size, min);
  const h = dense ? size : Math.max(size, min);
  const body = (
    <View style={{ width: w, height: h, padding: dense ? 0.5 : 1 }}>
      <View
        style={{ flex: 1, backgroundColor: colors.placeholder, borderRadius: rounded ? 10 : 0, overflow: "hidden" }}
      >
        {uri ? <CroppedImage uri={uri} crop={w === h ? crop : null} /> : null}
      </View>
    </View>
  );
  if (!onPress)
    return (
      <View accessible accessibilityRole="image" accessibilityLabel={label}>
        {body}
      </View>
    );
  return (
    <Tap label={label} role="imagebutton" onPress={onPress}>
      {body}
    </Tap>
  );
}
