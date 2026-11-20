import { useState } from "react";
import { FlatList, StyleSheet, View, useWindowDimensions } from "react-native";
import { Image } from "expo-image";
import { useTranslation } from "react-i18next";
import { useTheme } from "../theme/useTheme";
import { Icon, type IconName } from "../ui/Icon";
import { Tap } from "../ui/Tap";
import { useDisplay, useSquare } from "./CachedTile";
import type { Crop } from "./crop";

/** The species' card photo, shown as the hub's square cut to the card crop. */
export interface HeroCover {
  name: string;
  cover: string;
  crop: Crop | null;
}

function Page({
  photoId,
  width,
  height,
  groupIcon,
  groupColor,
  species,
}: {
  photoId: string;
  width: number;
  height: number;
  groupIcon: IconName;
  groupColor: string;
  species?: HeroCover;
}) {
  const { t } = useTranslation();
  const isCover = species?.cover === photoId;
  const display = useDisplay(photoId);
  const square = useSquare("species", species?.name ?? "", isCover ? photoId : null, species?.crop);
  const uri = square ?? display;
  const { colors } = useTheme();
  return (
    <View style={{ width, height, backgroundColor: colors.placeholder }}>
      {uri ? (
        <Image
          accessibilityLabel={t("viewer.photoLabel")}
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={0}
          accessibilityIgnoresInvertColors
        />
      ) : (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", opacity: 0.5 }}>
          <Icon name={groupIcon} size={120} color={groupColor} weight="regular" />
        </View>
      )}
    </View>
  );
}

/** The species page's hero: the card photo at a fixed height, swipe sideways for the other featured photos. */
export function HeroPager({
  ids,
  height,
  groupIcon,
  groupColor,
  species,
  onOpen,
}: {
  ids: string[];
  height: number;
  groupIcon: IconName;
  groupColor: string;
  species?: HeroCover;
  onOpen?: (photoId: string) => void;
}) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const { colors } = useTheme();
  const [page, setPage] = useState(0);
  if (!ids.length)
    return (
      <View
        style={{ width, height, backgroundColor: colors.placeholder, alignItems: "center", justifyContent: "center" }}
      >
        <View style={{ opacity: 0.5 }}>
          <Icon name={groupIcon} size={120} color={groupColor} weight="regular" />
        </View>
      </View>
    );
  return (
    <View style={{ width, height }}>
      <FlatList
        data={ids}
        horizontal
        pagingEnabled
        keyExtractor={(i) => i}
        showsHorizontalScrollIndicator={false}
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / width))}
        renderItem={({ item }) => {
          const page = (
            <Page
              photoId={item}
              width={width}
              height={height}
              groupIcon={groupIcon}
              groupColor={groupColor}
              species={species}
            />
          );
          return onOpen ? (
            <Tap label={t("viewer.photoLabel")} role="imagebutton" onPress={() => onOpen(item)}>
              {page}
            </Tap>
          ) : (
            page
          );
        }}
      />
      {ids.length > 1 ? (
        <View
          style={{
            position: "absolute",
            bottom: 10,
            left: 0,
            right: 0,
            flexDirection: "row",
            justifyContent: "center",
            gap: 6,
          }}
          pointerEvents="none"
        >
          {ids.map((id, i) => (
            <View
              key={id}
              style={{
                width: 7,
                height: 7,
                borderRadius: 4,
                backgroundColor: colors.canvas,
                opacity: i === page ? 0.95 : 0.45,
              }}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}
