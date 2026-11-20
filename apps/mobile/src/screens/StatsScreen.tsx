import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useApp, useLocal } from "../app/AppContext";
import { syncLine } from "../format/format";
import { useHeader } from "../navigation/useHeader";
import { useNav } from "../navigation/types";
import { stats, type PhotosToCount } from "../store/browse";
import { groupOf } from "../theme/groups";
import { type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";
import { GroupFooter, GroupHeader, InsetGroup, ListRow, StatTile } from "../ui";
import { COUNT_LABEL } from "../labels";

const COUNTS: PhotosToCount[] = ["all", "featured", "top"];
const n = (v: number) => v.toLocaleString("en");

/** Stats: big plain numbers, species by group, new species by year, and the species that deserve a look. */
export function StatsScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const nav = useNav();
  const app = useApp();
  const [count, setCount] = useState<PhotosToCount>("all");
  const { data } = useLocal((db) => stats(db, count), [count]);

  useHeader({
    noAccount: true,
    items: [
      {
        type: "menu",
        key: "count",
        label: t("stats.photosToCount"),
        icon: "filter",
        title: t("stats.photosToCount"),
        items: COUNTS.map((c) => ({
          type: "action",
          label: t(COUNT_LABEL[c]),
          checked: count === c,
          onPress: () => setCount(c),
        })),
      },
    ],
  });
  if (!data) return <View style={{ flex: 1, backgroundColor: colors.canvas }} />;

  const byGroup = Object.values(
    data.byGroup.reduce<Record<string, { group: ReturnType<typeof groupOf>; n: number }>>((acc, r) => {
      const g = groupOf(r.taxonClass);
      acc[g.id] = { group: g, n: (acc[g.id]?.n ?? 0) + r.n };
      return acc;
    }, {}),
  ).sort((a, b) => b.n - a.n);
  const maxGroup = Math.max(1, ...byGroup.map((g) => g.n));
  const maxYear = Math.max(1, ...data.byYear.map((y) => y.n));
  const line = syncLine({
    syncing: false,
    lastSyncAt: app.sync.lastSyncAt,
    waiting: 0,
    now: new Date(),
    reachable: true,
    desktop: true,
  });
  const { key, ...values } = line;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.canvas }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: 32 }}
    >
      <Text style={{ color: colors.muted, fontSize: type.subheadline.size, paddingHorizontal: 20, paddingBottom: 12 }}>
        {t(COUNT_LABEL[count])}
      </Text>
      <View style={{ paddingHorizontal: 16, gap: 12 }}>
        <View style={{ flexDirection: "row", gap: 12 }}>
          <StatTile value={n(data.photographed)} label={t("stats.photographed")} />
          <StatTile value={n(data.seenOnly)} label={t("stats.seenOnly")} />
        </View>
        <View style={{ flexDirection: "row", gap: 12 }}>
          <StatTile value={n(data.photos)} label={t("stats.photos")} />
          <StatTile value={n(data.regions)} label={t("stats.regions", { n: data.regions })} />
        </View>
      </View>

      {byGroup.length > 0 ? (
        <>
          <GroupHeader text={t("stats.byGroup")} />
          <InsetGroup>
            <View
              style={{ paddingHorizontal: 16, paddingVertical: 10 }}
              accessible
              accessibilityLabel={byGroup.map((g) => `${t(g.group.label)}, ${g.n}`).join(". ")}
            >
              {byGroup.map((g) => (
                <View key={g.group.id} style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 30 }}>
                  <Text numberOfLines={1} style={{ width: 96, color: colors.ink, fontSize: type.subheadline.size }}>
                    {t(g.group.label)}
                  </Text>
                  <View style={{ flex: 1 }}>
                    <View
                      style={{
                        width: `${Math.max(2, (g.n / maxGroup) * 100)}%`,
                        height: 14,
                        borderRadius: 4,
                        backgroundColor: colors[g.group.color],
                      }}
                    />
                  </View>
                  <Text
                    style={{
                      width: 44,
                      textAlign: "right",
                      color: colors.muted,
                      fontSize: type.subheadline.size,
                      fontVariant: ["tabular-nums"],
                    }}
                  >
                    {n(g.n)}
                  </Text>
                </View>
              ))}
            </View>
          </InsetGroup>
        </>
      ) : null}

      {data.byYear.length > 0 ? (
        <>
          <GroupHeader text={t("stats.byYear")} />
          <InsetGroup>
            <View
              style={{
                flexDirection: "row",
                alignItems: "flex-end",
                gap: 10,
                height: 150,
                paddingHorizontal: 16,
                paddingTop: 12,
                paddingBottom: 10,
              }}
              accessible
              accessibilityLabel={data.byYear.map((y) => `${y.year}, ${y.n}`).join(". ")}
            >
              {data.byYear.slice(-8).map((y) => (
                <View
                  key={y.year}
                  style={{ flex: 1, alignItems: "center", gap: 6, justifyContent: "flex-end", height: "100%" }}
                >
                  <Text style={{ color: colors.muted, fontSize: type.caption.size }}>{n(y.n)}</Text>
                  <View
                    style={{
                      width: "100%",
                      height: Math.max(4, (y.n / maxYear) * 80),
                      borderTopLeftRadius: 5,
                      borderTopRightRadius: 5,
                      borderBottomLeftRadius: 2,
                      borderBottomRightRadius: 2,
                      backgroundColor: colors.accent,
                    }}
                  />
                  <Text style={{ color: colors.muted, fontSize: type.caption.size }}>{y.year}</Text>
                </View>
              ))}
            </View>
          </InsetGroup>
        </>
      ) : null}

      {data.mostPhotographed.length > 0 ? (
        <>
          <GroupHeader text={t("stats.mostPhotographed")} />
          <InsetGroup>
            {data.mostPhotographed.map((s) => (
              <ListRow
                key={s.scientificName}
                title={s.commonName ?? s.scientificName}
                value={t("trips.photoCount", { n: s.n })}
                onPress={() => nav.navigate("Species", { scientificName: s.scientificName })}
              />
            ))}
          </InsetGroup>
        </>
      ) : null}
      {data.oneAndDoneCount > 0 ? (
        <>
          <GroupHeader text={t("stats.oneAndDone")} />
          <InsetGroup>
            {data.oneAndDone.map((s) => (
              <ListRow
                key={s.scientificName}
                title={s.commonName ?? s.scientificName}
                onPress={() => nav.navigate("Species", { scientificName: s.scientificName })}
              />
            ))}
          </InsetGroup>
          <GroupFooter text={t("stats.oneAndDoneNote", { n: data.oneAndDoneCount })} />
        </>
      ) : null}
      <GroupFooter
        text={t("stats.footer", { synced: app.mode === "paired" ? t(key, values) : t("sync.standalone") })}
      />
    </ScrollView>
  );
}
