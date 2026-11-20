import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { useApp, useLocal } from "../app/AppContext";
import { dateText, timeText } from "../format/dates";
import { useSheetHeader } from "../navigation/useHeader";
import { useNav, type RootParams } from "../navigation/types";
import { CachedTile } from "../photos/CachedTile";
import { photoInfo } from "../store/browse";
import { getSpecies } from "../store/marks";
import { InsetGroup, ListRow, Screen } from "../ui";

/** What is known about one photo: its species, when and where, the trip, albums and tags. */
export function PhotoInfoSheet({ route }: { route: { params: RootParams["PhotoInfo"] } }) {
  const { photoId } = route.params;
  const { t } = useTranslation();
  const app = useApp();
  const nav = useNav();
  useSheetHeader();
  const { data } = useLocal(async (db) => {
    const info = await photoInfo(db, photoId);
    return { info, species: info ? await getSpecies(db, info.scientificName) : null };
  }, [photoId]);
  if (!data?.info) return <Screen>{null}</Screen>;
  const { info, species } = data;
  // Where it was is never shown for a sensitive species.
  const sensitive = app.isSensitive(info.scientificName, !!species?.sensitive);
  const when = info.takenAt ? [dateText(t, info.takenAt), timeText(info.takenAt)].filter(Boolean).join(", ") : t("photos.undated");
  const open = (to: () => void) => () => {
    nav.goBack();
    setTimeout(to, 350);
  };
  return (
    <Screen padded={false}>
      <View style={{ paddingTop: 8 }}>
        <InsetGroup>
          <ListRow
            title={species?.commonName ?? info.scientificName}
            subtitle={species?.commonName ? info.scientificName : undefined}
            bold
            leading={<CachedTile photoId={photoId} size={52} width={52} rounded label={t("photos.tile")} />}
            leadingSize={52}
            onPress={open(() => nav.navigate("Species", { scientificName: info.scientificName }))}
          />
          <ListRow title={when} subtitle={sensitive ? t("viewer.placeHidden") : (info.place ?? undefined)} />
          {info.trip ? <ListRow title={info.trip.name} subtitle={t("viewer.trip")} onPress={open(() => nav.navigate("Trip", { id: info.trip!.id }))} /> : null}
          {info.albums.length ? <ListRow title={info.albums.join(", ")} subtitle={t("viewer.albums", { n: info.albums.length })} /> : null}
          {info.tags.length ? <ListRow title={info.tags.join(", ")} subtitle={t("viewer.tags")} /> : null}
        </InsetGroup>
      </View>
    </Screen>
  );
}
