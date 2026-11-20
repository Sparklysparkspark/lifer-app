import { Alert, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useApp, useLocal } from "../app/AppContext";
import { sizeText } from "../format/sizeText";
import { useHeader } from "../navigation/useHeader";
import { useNav } from "../navigation/types";
import { BYTES_PER_SPECIES, listRegions, regionProgress, removeRegion, type RegionRow } from "../store/regions";
import { useTheme } from "../theme/useTheme";
import { EmptyState, Icon, InsetGroup, GroupFooter, GroupHeader, ListRow, Screen, showActions } from "../ui";

/** Region checklists kept on the phone: what is kept, how far through each you are, and how big it is. */
export function RegionsScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const app = useApp();
  const nav = useNav();
  const { data } = useLocal(async (db) => {
    const kept = await listRegions(db);
    return {
      kept,
      progress: Object.fromEntries(
        await Promise.all(kept.map(async (r) => [r.key, await regionProgress(db, r.key)] as const)),
      ),
    };
  });
  useHeader({ noAccount: true });

  const size = (n: number) =>
    `${t("regions.speciesCount", { n })}, ${t("regions.about", { size: sizeText(t, n * BYTES_PER_SPECIES) })}`;
  const confirmRemove = (r: RegionRow) =>
    Alert.alert(t("regions.removeTitle", { name: r.name }), t("regions.removeBody"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("regions.remove"),
        style: "destructive",
        onPress: () => void removeRegion(app.db, r.key).then(app.bump),
      },
    ]);
  // Tap or long press: the same menu (MR12), with the system alert to confirm a removal (MR3).
  const menu = (r: RegionRow) =>
    showActions(r.name, t("common.cancel"), [
      { label: t("regions.remove"), destructive: true, onPress: () => confirmRemove(r) },
    ]);

  return (
    <Screen padded={false}>
      <GroupHeader text={t("regions.onPhone")} />
      {data && data.kept.length > 0 ? (
        <InsetGroup>
          {data.kept.map((r) => (
            <ListRow
              key={r.key}
              title={r.name}
              subtitle={size(r.speciesCount)}
              value={t("regions.progress", {
                seen: data.progress[r.key]?.seen ?? 0,
                total: data.progress[r.key]?.total ?? 0,
              })}
              chevron={false}
              onPress={() => menu(r)}
              onLongPress={() => menu(r)}
            />
          ))}
        </InsetGroup>
      ) : data ? (
        <EmptyState
          icon="regions"
          title={t("regions.empty")}
          line={t("regions.intro")}
          action={{ label: t("regions.add"), onPress: () => nav.navigate("AddRegion") }}
        />
      ) : null}
      {data && data.kept.length > 0 ? <GroupFooter text={t("regions.intro")} /> : null}
      <View style={{ paddingTop: 16 }}>
        <InsetGroup>
          <ListRow
            title={t("regions.add")}
            leadingSize={22}
            leading={<Icon name="add" size={22} color={colors.link} weight="semibold" />}
            onPress={() => nav.navigate("AddRegion")}
          />
        </InsetGroup>
      </View>
    </Screen>
  );
}
