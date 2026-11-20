import { memo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useFeatured } from "../photos/CachedTile";
import type { CollectionSpecies } from "../store/browse";
import { groupOf } from "../theme/groups";
import { radius, type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";
import { CroppedImage } from "./CroppedImage";
import { Glass } from "./Glass";
import { Icon, type IconName } from "./Icon";
import { Tap, type TapAction } from "./Tap";
import { TIER_LABEL } from "../labels";

const RARE = new Set(["rare", "legendary"]);

export const statusWord = (s: CollectionSpecies["status"]) =>
  s === "photographed" ? "species.statusPhotographed" : s === "seen" ? "species.statusSeen" : "species.statusNone";

/** What VoiceOver says for a species: names, status with photo count, then rarity. */
export function speciesLabel(t: (k: string, o?: Record<string, unknown>) => string, row: CollectionSpecies): string {
  const names = row.commonName ? `${row.commonName}, ${row.scientificName}` : row.scientificName;
  const status =
    row.status === "photographed" ? t("species.photographedCount", { n: row.photos }) : t(statusWord(row.status));
  return [
    `${names}.`,
    `${status}${row.isTarget ? `, ${t("species.target")}` : ""}.`,
    row.tier && TIER_LABEL[row.tier] ? `${t(TIER_LABEL[row.tier])}.` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

interface Props {
  row: CollectionSpecies;
  onPress: (scientificName: string) => void;
  /** The long press menu and VoiceOver actions. */
  actions: (row: CollectionSpecies) => TapAction[];
  onLongPress: (row: CollectionSpecies) => void;
  /** Show the tier label for every species (Arrange by rarity), not only Rare and above. */
  allTiers?: boolean;
  /** The naming preference in Settings. */
  scientificFirst?: boolean;
  /** Small cards (three across) hide the names; VoiceOver still reads them. */
  hideNames?: boolean;
}

/** The desktop's species card: a square photo, a name box, at most one badge. */
export const SpeciesCard = memo(function SpeciesCard({
  row,
  onPress,
  actions,
  onLongPress,
  allTiers,
  scientificFirst,
  hideNames,
}: Props) {
  const { t } = useTranslation();
  const { colors, appearance } = useTheme();
  const { uri, crop } = useFeatured("species", row.scientificName, row.coverPhotoId, row.cardCrop);
  const group = groupOf(row.taxonClass);
  const none = row.status === "none";
  const badge = row.isTarget ? "target" : row.status === "seen" ? "seen" : null;
  const showTier = !!row.tier && (allTiers || RARE.has(row.tier));
  return (
    <Tap
      label={speciesLabel(t, row)}
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
            style={{
              aspectRatio: 1,
              backgroundColor: colors["surface-muted"],
              alignItems: "center",
              justifyContent: "center",
              opacity: none ? 0.55 : 1,
            }}
          >
            {uri ? (
              <CroppedImage uri={uri} crop={crop} />
            ) : (
              <View style={{ opacity: none ? 1 : 0.5 }}>
                <Icon name={group.id as IconName} size={56} color={colors[group.color]} weight="regular" />
              </View>
            )}
          </View>
          {badge ? (
            <View style={{ position: "absolute", top: 8, right: 8 }}>
              <Glass style={{ height: 28, minWidth: 28, borderRadius: 14, overflow: "hidden" }}>
                <View
                  style={{
                    height: 28,
                    minWidth: 28,
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 4,
                    paddingHorizontal: badge === "seen" ? 8 : 0,
                  }}
                >
                  <Icon name={badge} size={15} color={colors.ink} weight="semibold" />
                  {badge === "seen" ? (
                    <Text style={{ color: colors.ink, fontSize: type.caption.size, fontWeight: "600" }}>
                      {t("species.statusSeen")}
                    </Text>
                  ) : null}
                </View>
              </Glass>
            </View>
          ) : null}
          {hideNames ? null : (
            <View style={{ paddingTop: 9, paddingBottom: 11, paddingHorizontal: 12, opacity: none ? 0.7 : 1 }}>
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
              {showTier ? (
                <View
                  style={{
                    alignSelf: "flex-start",
                    marginTop: 6,
                    paddingHorizontal: 7,
                    paddingVertical: 2,
                    borderRadius: 6,
                    backgroundColor: colors.accentTint,
                  }}
                >
                  <Text
                    style={{
                      color: colors.link,
                      fontSize: type.micro.size,
                      fontWeight: "600",
                      letterSpacing: 0.2,
                      textTransform: "uppercase",
                    }}
                  >
                    {t(TIER_LABEL[row.tier ?? ""] ?? "tiers.common")}
                  </Text>
                </View>
              ) : null}
            </View>
          )}
        </View>
      )}
    </Tap>
  );
});
