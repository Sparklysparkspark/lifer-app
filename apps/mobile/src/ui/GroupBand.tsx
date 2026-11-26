import { StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Image } from "expo-image";
import { useThumb } from "../photos/CachedTile";
import { groupById, type GroupId } from "../theme/groups";
import { radius, spacing, type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";
import { Icon, type IconName } from "./Icon";
import { ProgressBar } from "./ProgressBar";
import { Tap } from "./Tap";

interface Props {
  title: string;
  group: GroupId;
  photographed: number;
  total: number;
  /** The big number, formatted ("1,212"). */
  count: string;
  /** "of 480 photographed", after the big number. */
  ofTotal: string;
  /** Up to three of the group's photos. */
  photoIds: string[];
  /** One spoken label: "Birds, 212 of 480 photographed". */
  label: string;
  hint: string;
  onToggle: () => void;
}

function Thumb({ id }: { id: string }) {
  const { colors } = useTheme();
  const uri = useThumb(id);
  return (
    <View style={{ width: 30, height: 30, borderRadius: 8, overflow: "hidden", backgroundColor: colors.placeholder }}>
      {uri ? (
        <Image
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          recyclingKey={uri}
          transition={0}
          accessibilityIgnoresInvertColors
        />
      ) : null}
    </View>
  );
}

/** Show progress by group: a band per group with the big "212 of 480 photographed", a bar and a few photos. */
export function GroupBand({
  title,
  group,
  photographed,
  total,
  count,
  ofTotal,
  photoIds,
  label,
  hint,
  onToggle,
}: Props) {
  const { colors } = useTheme();
  const g = groupById(group);
  // At large text the photos give way so the name and the number keep the width.
  const large = useWindowDimensions().fontScale > 1.3;
  return (
    <Tap label={label} hint={hint} role="button" onPress={onToggle}>
      <View
        style={{
          marginHorizontal: spacing.gutter,
          marginBottom: 12,
          padding: 16,
          gap: 6,
          borderRadius: radius.panel,
          backgroundColor: colors.surface,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.hairline,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name={g.id as IconName} size={18} color={colors[g.color]} weight="semibold" />
          <Text style={{ flex: 1, color: colors.link, fontSize: type.headline.size, fontWeight: "600" }}>{title}</Text>
          {large ? null : photoIds.slice(0, 3).map((id) => <Thumb key={id} id={id} />)}
        </View>
        <Text style={{ color: colors.muted, fontSize: type.callout.size }}>
          <Text
            style={{ color: colors.ink, fontSize: type.display.size, fontWeight: "700", fontVariant: ["tabular-nums"] }}
          >
            {count}
          </Text>
          {` ${ofTotal}`}
        </Text>
        <ProgressBar fraction={total ? photographed / total : 0} label={label} />
      </View>
    </Tap>
  );
}
