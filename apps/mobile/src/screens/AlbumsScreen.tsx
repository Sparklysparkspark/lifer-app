import { useMemo, useState, type ReactNode } from "react";
import { FlatList, Text, View, useWindowDimensions } from "react-native";
import { useTranslation } from "react-i18next";
import { useApp, useLocal } from "../app/AppContext";
import { useHeader } from "../navigation/useHeader";
import { useNav } from "../navigation/types";
import { useFeatured } from "../photos/CachedTile";
import { listAlbums, type AlbumRow } from "../store/browse";
import { radius, type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";
import { CroppedImage, EmptyState, Glass, Icon, Segmented, Tap } from "../ui";
import { TripsScreen } from "./TripsScreen";
import { ALBUM_ARRANGE_LABEL } from "../labels";

type Arrange = "name" | "count";

function Cover({ album, onPress }: { album: AlbumRow; onPress: () => void }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { uri, crop } = useFeatured("album", album.id, album.coverPhotoId, album.coverCrop);
  return (
    <Tap label={t("albums.cardLabel", { name: album.name, n: album.count })} onPress={onPress} style={{ flex: 1 }}>
      <View style={{ aspectRatio: 1, borderRadius: radius.cover, overflow: "hidden", backgroundColor: colors.placeholder, alignItems: "center", justifyContent: "center" }}>
        {uri ? (
          <CroppedImage uri={uri} crop={crop} />
        ) : (
          <Icon name="albums" size={40} color={colors.muted} weight="regular" />
        )}
        {album.favourites ? (
          <View style={{ position: "absolute", left: 8, bottom: 8 }}>
            <Glass style={{ width: 28, height: 28, borderRadius: 14, overflow: "hidden" }}>
              <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                <Icon name="favourite" size={14} color={colors.ink} weight="semibold" />
              </View>
            </Glass>
          </View>
        ) : null}
      </View>
      <Text style={{ color: colors.ink, fontSize: type.subheadline.size, fontWeight: "600", marginTop: 6 }}>
        {album.name}
      </Text>
      <Text style={{ color: colors.muted, fontSize: type.subheadline.size }}>{album.count.toLocaleString("en")}</Text>
    </Tap>
  );
}

function AlbumsList({ header }: { header: ReactNode }) {
  const { t } = useTranslation();
  const app = useApp();
  const nav = useNav();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const [arrange, setArrange] = useState<Arrange>("name");
  const [query, setQuery] = useState("");
  const { data } = useLocal(listAlbums);

  useHeader({
    title: t("tabs.albums"),
    search: { placeholder: t("albums.searchPlaceholder"), onChange: setQuery, hideWhenScrolling: true },
    items: [
      {
        type: "menu",
        key: "arrange",
        label: t("albums.arrange"),
        icon: "filter",
        items: (["name", "count"] as const).map((a) => ({ type: "action", label: t(ALBUM_ARRANGE_LABEL[a]), checked: arrange === a, onPress: () => setArrange(a) })),
      },
    ],
  });

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = (data ?? []).filter((a) => !q || a.name.toLowerCase().includes(q));
    // Favourites always lead; the rest follow the choice.
    return arrange === "count" ? [...rows].sort((a, b) => Number(b.favourites) - Number(a.favourites) || b.count - a.count) : rows;
  }, [data, query, arrange]);
  const columns = width >= 700 ? 4 : 2;
  // Whole rows only, so the last row's cover keeps its width.
  const padded = shown.length % columns ? [...shown, ...Array.from({ length: columns - (shown.length % columns) }, () => null)] : shown;

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <FlatList
        key={columns}
        data={padded}
        numColumns={columns}
        keyExtractor={(a, i) => a?.id ?? `pad${i}`}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ListHeaderComponent={<View style={{ marginHorizontal: -16 }}>{header}</View>}
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 0, paddingBottom: 24, gap: 16 }}
        columnWrapperStyle={{ gap: 12 }}
        onRefresh={app.mode === "paired" ? () => void app.sync.run() : undefined}
        refreshing={app.sync.syncing}
        renderItem={({ item }) =>
          item ? <Cover album={item} onPress={() => nav.navigate("Photos", { title: item.name, scope: { kind: "album", id: item.id } })} /> : <View style={{ flex: 1 }} />
        }
        ListEmptyComponent={
          data ? (
            <EmptyState
              icon="albums"
              title={query.trim() ? t("albums.noMatch", { query: query.trim() }) : t("albums.emptyTitle")}
              line={query.trim() ? undefined : t(app.mode === "paired" ? "albums.emptyPaired" : "albums.empty")}
            />
          ) : undefined
        }
      />
    </View>
  );
}

const SEGMENTS = ["albums", "trips"] as const;

/** The Albums tab: covers two across as on the desktop (an album opens as a Gallery grid), or Trips, switched by a native control. */
export function AlbumsScreen() {
  const { t } = useTranslation();
  const app = useApp();
  const selected = app.settings.albumsSegment === "trips" ? 1 : 0;
  const header = (
    <Segmented
      label={t("albums.segments")}
      values={[t("tabs.albums"), t("tabs.trips")]}
      selected={selected}
      onChange={(i) => void app.updateSettings({ albumsSegment: SEGMENTS[i] })}
    />
  );
  return selected === 1 ? <TripsScreen header={header} /> : <AlbumsList header={header} />;
}
