import { useState } from "react";
import { Alert, FlatList, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useApp, useLocal } from "../app/AppContext";
import { rangeText } from "../format/dates";
import { useHeader } from "../navigation/useHeader";
import { useNav, type RootParams } from "../navigation/types";
import { PhotoGrid } from "../photos/PhotoGrid";
import { nearTargets } from "../store/browse";
import { endLocalTrip, listTrips, tripPhotos } from "../store/library";
import { regionKeysByHubId, regionProgress } from "../store/regions";
import { groupOf } from "../theme/groups";
import { type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";
import { EmptyState, Icon, ListRow, ProgressBar, Segmented, PageTitle, type IconName } from "../ui";
import { PART_LABEL } from "../labels";

const today = () => new Date().toISOString().slice(0, 10);
interface Row {
  scientificName: string;
  commonName: string | null;
  taxonClass?: string | null;
}
type Part = "targets" | "photos";
const PARTS: Part[] = ["targets", "photos"];

/** Trip mode: how far through the region's list you are, the targets left, and the trip's photos. */
export function TripScreen({ route }: { route: { params: RootParams["Trip"] } }) {
  const { id } = route.params;
  const { t } = useTranslation();
  const { colors } = useTheme();
  const nav = useNav();
  const app = useApp();
  const [part, setPart] = useState<Part>("targets");

  const { data } = useLocal(async (db) => {
    const trip = (await listTrips(db, today())).find((x) => x.id === id) ?? null;
    const keys = trip?.regionId ? await regionKeysByHubId(db, trip.regionId) : [];
    return {
      trip,
      progress: keys.length ? await regionProgress(db, keys[0]) : null,
      targets: await nearTargets(db, keys.length ? keys : null, 300),
      photos: await tripPhotos(db, id),
    };
  }, [id]);

  const trip = data?.trip ?? null;
  useHeader({
    title: trip?.name ?? "",
    noAccount: true,
    options: { headerLargeTitleEnabled: false },
    items: [
      {
        type: "menu",
        key: "more",
        label: t("common.more"),
        icon: "more",
        items: [
          ...(trip?.local && trip.active
            ? [
                {
                  type: "action",
                  label: t("trips.end"),
                  destructive: true,
                  onPress: () =>
                    Alert.alert(t("trips.endTitle"), t("trips.endBody"), [
                      { text: t("common.cancel"), style: "cancel" },
                      { text: t("trips.end"), style: "destructive", onPress: () => void endLocalTrip(app.db, id, today()).then(app.bump) },
                    ]),
                } as const,
              ]
            : []),
          ...(app.settings.hiddenTripBar === id
            ? [{ type: "action", label: t("trips.showAccessory"), onPress: () => void app.updateSettings({ hiddenTripBar: null }) } as const]
            : []),
        ],
      },
    ],
  });

  if (!data || !trip) return <View style={{ flex: 1, backgroundColor: colors.canvas }} />;

  const dates = rangeText(t, trip.startDate, trip.endDate);
  const header = (
    <View>
      <PageTitle text={trip.name} />
      <View style={{ paddingHorizontal: 20, gap: 8 }}>
        {dates ? <Text style={{ color: colors.muted, fontSize: type.subheadline.size }}>{dates}</Text> : null}
        {data.progress ? (
          <View style={{ gap: 6 }}>
            <Text style={{ color: colors.ink, fontSize: type.headline.size, fontWeight: "600" }}>{t("trips.progress", { seen: data.progress.seen, total: data.progress.total })}</Text>
            <ProgressBar fraction={data.progress.total ? data.progress.seen / data.progress.total : 0} label={t("trips.progress", { seen: data.progress.seen, total: data.progress.total })} />
          </View>
        ) : null}
      </View>
      <Segmented label={t("trips.parts")} values={PARTS.map((p) => t(PART_LABEL[p]))} selected={PARTS.indexOf(part)} onChange={(i) => setPart(PARTS[i])} />
    </View>
  );

  if (part === "photos")
    return (
      <View style={{ flex: 1, backgroundColor: colors.canvas }}>
        <PhotoGrid
          photos={data.photos}
          byMonth
          header={header}
          onOpen={(index) => nav.navigate("Viewer", { ids: data.photos.map((p) => p.photoId), index })}
          empty={<EmptyState icon="gallery" title={t("trips.noPhotos")} />}
        />
      </View>
    );

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <FlatList<Row>
        data={data.targets}
        keyExtractor={(s) => s.scientificName}
        contentInsetAdjustmentBehavior="automatic"
        ListHeaderComponent={header}
        contentContainerStyle={{ paddingBottom: 24 }}
        ListEmptyComponent={<EmptyState icon="target" title={t("trips.noTargets")} line={t("trips.noTargetsLine")} />}
        renderItem={({ item }) => {
          const name = item.commonName ?? item.scientificName;
          const g = groupOf(item.taxonClass ?? null);
          return (
            <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 16, paddingRight: 16, minHeight: 64, gap: 12 }}>
              <View style={{ flex: 1 }}>
                <ListRow
                  title={name}
                  subtitle={t("species.target")}
                  leadingSize={0}
                  chevron={false}
                  onPress={() => nav.navigate("Species", { scientificName: item.scientificName })}
                />
              </View>
              <Icon name={g.id as IconName} size={20} color={colors[g.color]} />
            </View>
          );
        }}
      />
    </View>
  );
}

