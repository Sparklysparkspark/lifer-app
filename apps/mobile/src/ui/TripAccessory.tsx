import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useThumb } from "../photos/CachedTile";
import { type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";
import { Tap } from "./Tap";
import { Image } from "expo-image";

export interface AccessoryTrip {
  id: string;
  name: string;
  seen: number | null;
  total: number | null;
  coverPhotoId: string | null;
}

interface Props {
  trip: AccessoryTrip;
  placement: "regular" | "inline";
  onOpen: () => void;
  onMenu: () => void;
}

/** The active trip above the tab bar on every tab: its name and progress, . */
export function TripAccessory({ trip, placement, onOpen, onMenu }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const uri = useThumb(trip.coverPhotoId);
  const progress =
    trip.seen != null && trip.total ? t("trips.progress", { seen: trip.seen, total: trip.total }) : t("trips.active");
  const compact = placement === "inline";
  return (
    <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: 8, paddingRight: 6 }}>
      <Tap
        label={t("trips.accessoryLabel", { name: trip.name, progress })}
        hint={t("trips.accessoryHint")}
        onPress={onOpen}
        onLongPress={onMenu}
        actions={[{ name: "hide", label: t("trips.hideAccessory"), onPress: onMenu }]}
        style={{ flex: 1 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          {compact ? null : (
            <View
              style={{
                width: 38,
                height: 38,
                borderRadius: 19,
                overflow: "hidden",
                backgroundColor: colors["surface-muted"],
              }}
            >
              {uri ? (
                <Image
                  source={{ uri }}
                  style={{ flex: 1 }}
                  contentFit="cover"
                  transition={0}
                  accessibilityIgnoresInvertColors
                />
              ) : null}
            </View>
          )}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text
              numberOfLines={1}
              maxFontSizeMultiplier={1.3}
              style={{ color: colors.ink, fontSize: type.subheadline.size, fontWeight: "600" }}
            >
              {trip.name}
            </Text>
            {compact ? null : (
              <Text
                numberOfLines={1}
                maxFontSizeMultiplier={1.3}
                style={{ color: colors.muted, fontSize: type.footnote.size }}
              >
                {progress}
              </Text>
            )}
          </View>
        </View>
      </Tap>
    </View>
  );
}
