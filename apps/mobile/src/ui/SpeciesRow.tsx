import { memo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { useTranslation } from "react-i18next";
import { useThumb } from "../photos/CachedTile";
import { referenceId } from "../photos/reference";
import type { CollectionSpecies } from "../store/browse";
import { groupOf } from "../theme/groups";
import { type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";
import { Icon, type IconName } from "./Icon";
import { speciesLabel, statusWord } from "./SpeciesCard";
import { Tap, type TapAction } from "./Tap";

interface Props {
  row: CollectionSpecies;
  onPress: (scientificName: string) => void;
  actions?: (row: CollectionSpecies) => TapAction[];
  onLongPress?: (row: CollectionSpecies) => void;
  scientificFirst?: boolean;
}

/** One species as a row with a thumbnail: the List size of Collection, and search results elsewhere. */
export const SpeciesRow = memo(function SpeciesRow({ row, onPress, actions, onLongPress, scientificFirst }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const uri = useThumb(row.coverPhotoId ?? referenceId(row.scientificName));
  const group = groupOf(row.taxonClass);
  const first = scientificFirst ? row.scientificName : (row.commonName ?? row.scientificName);
  const second = row.commonName ? (scientificFirst ? row.commonName : row.scientificName) : null;
  const status = [t(statusWord(row.status)), row.isTarget ? t("species.target") : null].filter(Boolean).join(", ");
  return (
    <Tap
      label={speciesLabel(t, row)}
      onPress={() => onPress(row.scientificName)}
      onLongPress={onLongPress ? () => onLongPress(row) : undefined}
      actions={actions?.(row)}
    >
      <View
        style={{
          minHeight: 68,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingHorizontal: 16,
          paddingVertical: 8,
          backgroundColor: colors.canvas,
        }}
      >
        <View
          style={{
            width: 52,
            height: 52,
            borderRadius: 10,
            overflow: "hidden",
            backgroundColor: colors["surface-muted"],
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {uri ? (
            <Image
              source={{ uri }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              recyclingKey={uri}
              transition={0}
              accessibilityIgnoresInvertColors
            />
          ) : (
            <Icon name={group.id as IconName} size={26} color={colors[group.color]} weight="regular" />
          )}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            style={{ color: colors.ink, fontSize: type.body.size, fontStyle: scientificFirst ? "italic" : "normal" }}
          >
            {first}
          </Text>
          <Text style={{ color: colors.muted, fontSize: type.subheadline.size }}>
            {status}
            {second ? <Text style={{ fontStyle: scientificFirst ? "normal" : "italic" }}>{`. ${second}`}</Text> : null}
          </Text>
        </View>
        <Icon name="chevronRight" size={14} color={colors.muted} weight="bold" />
      </View>
      <View style={{ position: "absolute", left: 80, right: 0, bottom: 0, height: 1, backgroundColor: colors.sep }} />
    </Tap>
  );
});
