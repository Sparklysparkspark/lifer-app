import { memo } from "react";
import { Platform, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { useTranslation } from "react-i18next";
import { tierPills, type Pill } from "../collection/tiers";
import { useFeatured } from "../photos/CachedTile";
import type { CollectionSpecies } from "../store/browse";
import { groupOf } from "../theme/groups";
import { radius, type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";
import { CroppedImage } from "./CroppedImage";
import { Icon, type IconName } from "./Icon";
import { Tap, type TapAction } from "./Tap";
import { TierPills } from "./TierLabel";

type T = (k: string, o?: Record<string, unknown>) => string;

export const statusWord = (s: CollectionSpecies["status"]) =>
  s === "photographed" ? "species.statusPhotographed" : s === "seen" ? "species.statusSeen" : "species.statusNone";

/** The rarity pills a card or row shows, or none when Show rarity tags is off. */
export const cardPills = (t: T, row: CollectionSpecies, region: string | null, show = true): Pill[] =>
  show
    ? tierPills(
        t,
        {
          localTier: row.localTier,
          localTierReason: row.localTierReason,
          worldTier: row.worldTier,
          worldTierReason: row.tierReason,
        },
        region,
      )
    : [];

/** What VoiceOver says for a species: names, status with photo count, then the pills with the region named. */
export function speciesLabel(t: T, row: CollectionSpecies, pills: Pill[] = []): string {
  const names = row.commonName ? `${row.commonName}, ${row.scientificName}` : row.scientificName;
  const status =
    row.status === "photographed" ? t("species.photographedCount", { n: row.photos }) : t(statusWord(row.status));
  return [
    `${names}.`,
    `${status}${row.isTarget ? `, ${t("species.target")}` : ""}.`,
    pills.length ? `${pills.map((p) => p.label).join(", ")}.` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

// The desktop's cover rules (theme.css cover-seen, cover-uncollected). `filter` greys on Android; iOS
// draws only brightness from it (grayscale needs a native flag that is off), so a colour-blend layer greys there.
const GREY: Record<"light" | "dark", ViewStyle["filter"]> = {
  light: [{ grayscale: 0.95 }, { sepia: 0.35 }, { contrast: 0.9 }, { brightness: 1.08 }],
  dark: [{ grayscale: 0.95 }, { contrast: 0.95 }, { brightness: 0.85 }],
};
const IN_COLOUR: ViewStyle["filter"] = [{ brightness: 0.88 }, { saturate: 0.88 }];

interface Props {
  row: CollectionSpecies;
  onPress: (scientificName: string) => void;
  /** The long press menu and VoiceOver actions. */
  actions: (row: CollectionSpecies) => TapAction[];
  onLongPress: (row: CollectionSpecies) => void;
  /** The chosen region's name, null for Everywhere: two pills inside a region, one outside. */
  region?: string | null;
  showRarityTags?: boolean;
  /** Show uncollected species in colour: unphotographed covers stay in colour, a touch dimmer. */
  uncollectedColour?: boolean;
  /** The naming preference in Settings. */
  scientificFirst?: boolean;
  /** View > Hide names: the photo alone; VoiceOver still reads the names. */
  hideNames?: boolean;
}

/** The desktop's species card: a square photo with small marks top left, the names, the rarity pills. */
export const SpeciesCard = memo(function SpeciesCard({
  row,
  onPress,
  actions,
  onLongPress,
  region = null,
  showRarityTags = true,
  uncollectedColour,
  scientificFirst,
  hideNames,
}: Props) {
  const { t } = useTranslation();
  const { colors, appearance } = useTheme();
  const { uri, crop } = useFeatured("species", row.scientificName, row.coverPhotoId, row.cardCrop);
  const group = groupOf(row.taxonClass);
  const none = row.status === "none";
  const seen = row.status === "seen";
  const dark = appearance === "dark";
  const pills = cardPills(t, row, region, showRarityTags);
  const cover: ViewStyle = seen
    ? { opacity: dark ? 0.6 : 0.45 }
    : none && uri
      ? { filter: uncollectedColour ? IN_COLOUR : GREY[dark ? "dark" : "light"], isolation: "isolate" }
      : {};
  const marks = [seen ? "seen" : null, row.isTarget ? "target" : null].filter(Boolean) as IconName[];
  return (
    <Tap
      label={speciesLabel(t, row, pills)}
      onPress={() => onPress(row.scientificName)}
      onLongPress={() => onLongPress(row)}
      actions={actions(row)}
      style={{ flex: 1 }}
    >
      {(pressed) => (
        <View
          style={{
            flex: 1,
            borderRadius: radius.card,
            overflow: "hidden",
            backgroundColor: colors.surface,
            borderWidth: appearance === "sunlight" ? 1 : StyleSheet.hairlineWidth,
            borderColor: colors.hairline,
            transform: [{ scale: pressed ? 0.97 : 1 }],
          }}
        >
          <View
            testID="cover"
            style={{
              aspectRatio: 1,
              backgroundColor: colors["surface-muted"],
              alignItems: "center",
              justifyContent: "center",
              ...cover,
            }}
          >
            {uri ? (
              <CroppedImage uri={uri} crop={crop} />
            ) : (
              <View style={{ opacity: none ? 1 : 0.5 }}>
                <Icon name={group.id as IconName} size={56} color={colors[group.color]} weight="regular" />
              </View>
            )}
            {none && uri && !uncollectedColour && Platform.OS === "ios" ? (
              <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.coverTone, mixBlendMode: "color" }]} />
            ) : null}
          </View>
          {marks.length ? (
            <View style={{ position: "absolute", top: 8, left: 8, flexDirection: "row", gap: 4 }}>
              {marks.map((m) => (
                <View
                  key={m}
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 13,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: colors.glass,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: colors.hairline,
                  }}
                >
                  <Icon name={m} size={14} color={colors.muted} weight="regular" />
                </View>
              ))}
            </View>
          ) : null}
          {hideNames && !pills.length ? null : (
            <View style={{ paddingTop: 9, paddingBottom: 11, paddingHorizontal: 12, gap: 6, opacity: none ? 0.7 : 1 }}>
              {hideNames ? null : (
                <View>
                  <Text
                    style={{
                      color: colors.ink,
                      fontSize: type.subheadline.size,
                      fontWeight: "600",
                      letterSpacing: -0.2,
                      fontStyle: scientificFirst ? "italic" : "normal",
                    }}
                  >
                    {scientificFirst ? row.scientificName : (row.commonName ?? row.scientificName)}
                  </Text>
                  {row.commonName ? (
                    <Text
                      style={{
                        color: colors.muted,
                        fontSize: type.footnote.size,
                        fontStyle: scientificFirst ? "normal" : "italic",
                      }}
                    >
                      {scientificFirst ? row.commonName : row.scientificName}
                    </Text>
                  ) : null}
                </View>
              )}
              <TierPills pills={pills} />
            </View>
          )}
        </View>
      )}
    </Tap>
  );
});
