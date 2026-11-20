import { Children, cloneElement, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { Platform, Text, View } from "react-native";
import { MIN_TOUCH, radius, spacing, type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";
import { Icon } from "./Icon";
import { Tap } from "./Tap";

interface RowProps {
  title: string;
  subtitle?: string;
  /** Muted text at the trailing edge (a count, a status). */
  value?: string;
  /** A thumbnail or icon tile before the text. */
  leading?: ReactNode;
  /** Width of `leading`, so the separator lines up under the text. */
  leadingSize?: number;
  /** Any control at the trailing edge (a switch, a small button). */
  accessory?: ReactNode;
  selected?: boolean;
  /** Shows a chevron; default when the row can be pressed. */
  chevron?: boolean;
  bold?: boolean;
  destructive?: boolean;
  /** The title in the link colour, for a row that is an action. */
  link?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  hint?: string;
  /** Set by InsetGroup. */
  separator?: boolean;
}

/** One row of an InsetGroup: label left, value or control right (L3). */
export function ListRow({
  title,
  subtitle,
  value,
  leading,
  leadingSize = 0,
  accessory,
  selected,
  chevron,
  bold,
  destructive,
  link,
  onPress,
  onLongPress,
  hint,
  separator,
}: RowProps) {
  const { colors } = useTheme();
  const showChevron = chevron ?? (!!onPress && selected === undefined && !accessory);
  const body = (
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
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            left: spacing.item + (leadingSize ? leadingSize + 12 : 0),
            height: 1,
            backgroundColor: colors.sep,
          }}
        />
      ) : null}
      {leading}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          style={{
            color: destructive ? colors.danger : link ? colors.link : colors.ink,
            fontSize: type.body.size,
            fontWeight: bold || link ? "600" : "400",
          }}
        >
          {title}
        </Text>
        {subtitle ? <Text style={{ color: colors.muted, fontSize: type.subheadline.size }}>{subtitle}</Text> : null}
      </View>
      {value ? (
        <Text numberOfLines={1} style={{ color: colors.muted, fontSize: type.body.size, maxWidth: "45%" }}>
          {value}
        </Text>
      ) : null}
      {accessory}
      {selected ? <Icon name="check" size={18} color={colors.link} weight="bold" /> : null}
      {showChevron ? <Icon name="chevronRight" size={14} color={colors.muted} weight="bold" /> : null}
    </View>
  );
  if (!onPress && !onLongPress) return body;
  return (
    <Tap
      label={[title, subtitle, value].filter(Boolean).join(", ")}
      hint={hint}
      selected={selected}
      onPress={onPress}
      onLongPress={onLongPress}
    >
      {body}
    </Tap>
  );
}

/** Rows in one rounded surface, with separators inset from the text (22 pt corners). */
export function InsetGroup({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  // Rows may arrive inside fragments (a conditional pair of rows); each one gets its own separator.
  const flat = (nodes: ReactNode): ReactElement<{ separator?: boolean }>[] =>
    Children.toArray(nodes).flatMap((n) =>
      isValidElement(n)
        ? n.type === Fragment
          ? flat((n.props as { children?: ReactNode }).children)
          : [n as ReactElement<{ separator?: boolean }>]
        : [],
    );
  const rows = flat(children);
  return (
    <View
      style={{
        marginHorizontal: spacing.gutter,
        borderRadius: radius.group,
        backgroundColor: colors.surface,
        overflow: "hidden",
        borderWidth: 1,
        borderColor: colors.hairline,
      }}
    >
      {rows.map((r, i) => cloneElement(r, { key: r.key ?? i, separator: i > 0 }))}
    </View>
  );
}

/** The small caption above an InsetGroup. */
export function GroupHeader({ text }: { text: string }) {
  const { colors } = useTheme();
  return (
    <Text
      accessibilityRole="header"
      style={{
        color: colors.muted,
        fontSize: type.footnote.size,
        textTransform: "uppercase",
        letterSpacing: 0.2,
        paddingHorizontal: spacing.gutter * 2,
        paddingTop: 20,
        paddingBottom: 7,
      }}
    >
      {text}
    </Text>
  );
}

/** The quiet line below a group. */
export function GroupFooter({ text }: { text: string }) {
  const { colors } = useTheme();
  return (
    <Text
      style={{
        color: colors.muted,
        fontSize: type.footnote.size,
        paddingHorizontal: spacing.gutter * 2,
        paddingTop: 8,
      }}
    >
      {text}
    </Text>
  );
}
