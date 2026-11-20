import { Text, View, useWindowDimensions } from "react-native";
import { spacing, type } from "../theme/theme";
import { groupById, type GroupId } from "../theme/groups";
import { useTheme } from "../theme/useTheme";
import { Icon, type IconName } from "./Icon";
import { Tap } from "./Tap";

interface Props {
  title: string;
  /** "318 of 402" at the trailing edge. */
  count?: string;
  /** A group id: draws its glyph in the taxa colour. */
  group?: GroupId;
  /** Spoken in full, e.g. "Birds, 318 of 402 photographed". */
  label?: string;
  /** Makes the header a button that folds its section; `collapsed` turns the chevron. */
  onToggle?: () => void;
  collapsed?: boolean;
  /** Spoken hint of the toggle, e.g. "Collapses the group". */
  hint?: string;
}

/** A section title with the group glyph and a count; sticky inside a list, so it keeps the canvas colour. */
export function SectionHeader({ title, count, group, label, onToggle, collapsed, hint }: Props) {
  const { colors } = useTheme();
  const g = group ? groupById(group) : null;
  // At large text sizes the count drops under the name instead of squeezing it.
  const stacked = useWindowDimensions().fontScale > 1.3;
  const spoken = label ?? [title, count].filter(Boolean).join(", ");
  const row = (
    <View
      {...(onToggle ? {} : { accessible: true, accessibilityRole: "header" as const, accessibilityLabel: spoken })}
      style={{
        flexDirection: stacked ? "column" : "row",
        alignItems: stacked ? "flex-start" : "center",
        gap: 8,
        paddingHorizontal: spacing.page,
        paddingTop: 22,
        paddingBottom: 10,
        backgroundColor: colors.canvas,
      }}
    >
      {g ? <Icon name={g.id as IconName} size={22} color={colors[g.color]} weight="semibold" /> : null}
      <Text style={{ flex: stacked ? 0 : 1, flexShrink: 1, color: colors.ink, fontSize: type["title-3"].size, fontWeight: "700" }}>
        {title}
      </Text>
      {count ? (
        <Text numberOfLines={1} style={{ color: colors.muted, fontSize: type.subheadline.size }}>
          {count}
        </Text>
      ) : null}
      {onToggle ? <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={14} color={colors.muted} weight="bold" /> : null}
    </View>
  );
  return onToggle ? (
    <Tap label={spoken} hint={hint} role="button" onPress={onToggle} style={{ backgroundColor: colors.canvas }}>
      {row}
    </Tap>
  ) : (
    row
  );
}
