import { useMemo, useState, type ReactNode } from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { useTranslation } from "react-i18next";
import { useLocal } from "../app/AppContext";
import { useCollectionView } from "../collection/view";
import { rangeText } from "../format/dates";
import { useHeader } from "../navigation/useHeader";
import { useNav } from "../navigation/types";
import { CachedTile, useFeatured } from "../photos/CachedTile";
import type { Crop } from "../photos/crop";
import { nearTargets, regionTargets, tripCoverCrops, tripCovers } from "../store/browse";
import { listTrips, type TripRow } from "../store/library";
import { listRegions, regionKeysByHubId, regionProgress } from "../store/regions";
import { groupOf } from "../theme/groups";
import { ON_BACKDROP, PHOTO_WASH, radius, type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";
import {
  Button,
  EmptyState,
  GroupHeader,
  Icon,
  InsetGroup,
  ListRow,
  Note,
  ProgressBar,
  Tap,
  type IconName,
} from "../ui";

const today = () => new Date().toISOString().slice(0, 10);

function dayOf(trip: TripRow): { day: number; of: number | null } | null {
  if (!trip.startDate) return null;
  const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
  const day = Math.floor((ms(today()) - ms(trip.startDate)) / 86_400_000) + 1;
  return {
    day: Math.max(1, day),
    of: trip.endDate ? Math.floor((ms(trip.endDate) - ms(trip.startDate)) / 86_400_000) + 1 : null,
  };
}

function NowCard({
  trip,
  regionName,
  progress,
  targetsLeft,
  cover,
  crop,
  onOpen,
}: {
  trip: TripRow;
  regionName: string | null;
  progress: { seen: number; total: number } | null;
  targetsLeft: number;
  cover: string | null;
  crop?: Crop | null;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { uri } = useFeatured("trip", trip.id, cover, crop);
  const d = dayOf(trip);
  const line = [d ? t(d.of ? "trips.dayOf" : "trips.day", { day: d.day, of: d.of }) : null, regionName]
    .filter(Boolean)
    .join(", ");
  return (
    <View
      style={{
        marginHorizontal: 16,
        marginTop: 14,
        borderRadius: radius.group + 2,
        overflow: "hidden",
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.hairline,
      }}
    >
      <Tap label={t("trips.nowLabel", { name: trip.name, line })} onPress={onOpen}>
        <View style={{ minHeight: 150, backgroundColor: colors.placeholder, justifyContent: "flex-end" }}>
          {uri ? (
            <Image
              source={{ uri }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              transition={0}
              accessibilityIgnoresInvertColors
            />
          ) : null}
          <View style={{ backgroundColor: PHOTO_WASH, paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text
              style={{
                color: ON_BACKDROP,
                opacity: 0.9,
                fontSize: type.footnote.size,
                fontWeight: "600",
                letterSpacing: 0.3,
                textTransform: "uppercase",
              }}
            >
              {t("trips.now")}
            </Text>
            <Text style={{ color: ON_BACKDROP, fontSize: type["title-2"].size, fontWeight: "700" }}>{trip.name}</Text>
            {line ? (
              <Text style={{ color: ON_BACKDROP, opacity: 0.9, fontSize: type.subheadline.size }}>{line}</Text>
            ) : null}
          </View>
        </View>
      </Tap>
      <View style={{ padding: 16, paddingTop: 12, gap: 10 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Text
            style={{
              flexGrow: 1,
              flexShrink: 1,
              color: colors.ink,
              fontSize: type.subheadline.size,
              fontWeight: "600",
            }}
          >
            {progress
              ? t("trips.progress", { seen: progress.seen, total: progress.total })
              : t("trips.speciesCount", { n: trip.species })}
          </Text>
          {progress ? (
            <Text style={{ color: colors.muted, fontSize: type.subheadline.size }}>
              {t("trips.targetsLeft", { n: targetsLeft })}
            </Text>
          ) : null}
        </View>
        {progress ? (
          <ProgressBar
            fraction={progress.total ? progress.seen / progress.total : 0}
            label={t("trips.progress", { seen: progress.seen, total: progress.total })}
          />
        ) : null}
      </View>
    </View>
  );
}

function TripListRow({
  trip,
  cover,
  crop,
  onPress,
}: {
  trip: TripRow;
  cover: string | undefined;
  crop?: Crop | null;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const subtitle = [rangeText(t, trip.startDate, trip.endDate), t("trips.speciesCount", { n: trip.species })]
    .filter(Boolean)
    .join(", ");
  return (
    <ListRow
      title={trip.name}
      subtitle={subtitle}
      leadingSize={52}
      leading={
        cover ? (
          <CachedTile photoId={cover} size={52} width={52} rounded crop={crop} label={t("photos.tile")} />
        ) : (
          <View
            style={{
              width: 52,
              height: 52,
              borderRadius: 10,
              backgroundColor: colors.placeholder,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="trips" size={22} color={colors.muted} weight="regular" />
          </View>
        )
      }
      onPress={onPress}
    />
  );
}

/** Trips: the active trip leads, your targets in a region, then upcoming and past trips. */
export function TripsScreen({ header }: { header?: ReactNode } = {}) {
  const { t } = useTranslation();
  const nav = useNav();
  const { colors } = useTheme();
  const { view, update } = useCollectionView();
  const [query, setQuery] = useState("");

  useHeader({
    title: t("tabs.albums"),
    search: { placeholder: t("trips.searchPlaceholder"), onChange: setQuery },
    items: [
      { type: "button", key: "start", label: t("trips.start"), icon: "add", onPress: () => nav.navigate("StartTrip") },
    ],
  });

  const { data } = useLocal(
    async (db) => {
      const trips = await listTrips(db, today());
      const active = trips.find((x) => x.active) ?? null;
      const regions = await listRegions(db);
      const keysFor = async (regionId: string | null) => (regionId ? await regionKeysByHubId(db, regionId) : []);
      const tripKeys = await keysFor(active?.regionId ?? null);
      const progress = tripKeys.length ? await regionProgress(db, tripKeys[0]) : null;
      const yours = view.region ? regions.find((r) => r.key === view.region) : null;
      return {
        trips,
        active,
        progress,
        targetsLeft: tripKeys.length ? (await nearTargets(db, tripKeys, 500)).length : 0,
        covers: await tripCovers(db),
        coverCrops: await tripCoverCrops(db),
        regionName: tripKeys.length ? (regions.find((r) => r.key === tripKeys[0])?.name ?? null) : null,
        yours: await regionTargets(db, view.region ? [view.region] : null, 6),
        yoursName: yours?.name ?? null,
        regions: regions.length,
      };
    },
    [view.region],
  );

  const q = query.trim().toLowerCase();
  const rest = useMemo(
    () => (data?.trips ?? []).filter((x) => !x.active && (!q || x.name.toLowerCase().includes(q))),
    [data, q],
  );
  const upcoming = rest.filter((x) => x.startDate && x.startDate > today());
  const past = rest.filter((x) => !upcoming.includes(x));

  const nothing = !!data && data.trips.length === 0;

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <FlatList
        style={{ flex: 1 }}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: 32 }}
        data={[0]}
        keyExtractor={() => "trips"}
        renderItem={() => (
          <View>
            {header}
            {data?.active && !q ? (
              <NowCard
                trip={data.active}
                regionName={data.regionName}
                progress={data.progress}
                targetsLeft={data.targetsLeft}
                cover={data.covers[data.active.id] ?? null}
                crop={data.coverCrops[data.active.id]}
                onOpen={() => nav.navigate("Trip", { id: data.active!.id })}
              />
            ) : null}

            {data && !q ? (
              <>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    paddingHorizontal: 20,
                    paddingTop: 24,
                    paddingBottom: 10,
                  }}
                >
                  <Icon name="regions" size={18} color={colors.link} weight="semibold" />
                  <Text
                    accessibilityRole="header"
                    style={{ flex: 1, color: colors.ink, fontSize: type["title-3"].size, fontWeight: "700" }}
                  >
                    {data.yoursName ? t("trips.yourTargetsIn", { region: data.yoursName }) : t("trips.yourTargets")}
                  </Text>
                  {data.yours.length > 0 ? (
                    <Button
                      variant="plain"
                      compact
                      label={t("trips.seeAll")}
                      onPress={() => {
                        update({ show: "targets" });
                        nav.navigate("Tabs", { screen: "Collection" });
                      }}
                    />
                  ) : null}
                </View>
                {data.yours.length === 0 ? (
                  <View style={{ paddingHorizontal: 20 }}>
                    <Note text={t(data.regions === 0 ? "trips.nearNoRegions" : "trips.nearNone")} />
                  </View>
                ) : (
                  <InsetGroup>
                    {data.yours.map((s) => {
                      const g = groupOf(s.taxonClass);
                      return (
                        <ListRow
                          key={s.scientificName}
                          title={s.commonName ?? s.scientificName}
                          subtitle={t(s.seen ? "trips.targetSeen" : "species.target")}
                          leadingSize={52}
                          leading={
                            <View
                              style={{
                                width: 52,
                                height: 52,
                                borderRadius: 10,
                                backgroundColor: colors.placeholder,
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                            >
                              <Icon name={g.id as IconName} size={26} color={colors[g.color]} weight="regular" />
                            </View>
                          }
                          onPress={() => nav.navigate("Species", { scientificName: s.scientificName })}
                        />
                      );
                    })}
                  </InsetGroup>
                )}
              </>
            ) : null}

            {data && upcoming.length > 0 ? (
              <>
                <GroupHeader text={t("trips.upcoming")} />
                <InsetGroup>
                  {upcoming.map((x) => (
                    <TripListRow
                      key={x.id}
                      trip={x}
                      cover={data.covers[x.id]}
                      crop={data.coverCrops[x.id]}
                      onPress={() => nav.navigate("Trip", { id: x.id })}
                    />
                  ))}
                </InsetGroup>
              </>
            ) : null}
            {data && past.length > 0 ? (
              <>
                <View style={{ paddingHorizontal: 20, paddingTop: 24, paddingBottom: 10 }}>
                  <Text
                    accessibilityRole="header"
                    style={{ color: colors.ink, fontSize: type["title-3"].size, fontWeight: "700" }}
                  >
                    {t("trips.past")}
                  </Text>
                </View>
                <InsetGroup>
                  {past.map((x) => (
                    <TripListRow
                      key={x.id}
                      trip={x}
                      cover={data.covers[x.id]}
                      crop={data.coverCrops[x.id]}
                      onPress={() => nav.navigate("Trip", { id: x.id })}
                    />
                  ))}
                </InsetGroup>
              </>
            ) : null}
            {nothing ? (
              <EmptyState
                icon="trips"
                title={t("trips.emptyTitle")}
                line={t("trips.empty")}
                action={{ label: t("trips.start"), onPress: () => nav.navigate("StartTrip") }}
              />
            ) : null}
            {!nothing && q && rest.length === 0 ? (
              <EmptyState icon="search" title={t("trips.noMatch", { query: query.trim() })} />
            ) : null}
          </View>
        )}
      />
    </View>
  );
}
