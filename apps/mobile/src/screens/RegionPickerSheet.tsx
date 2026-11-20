import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useApp, useLocal } from "../app/AppContext";
import { buildRegionTree } from "../collection/regionTree";
import { useCollectionView } from "../collection/view";
import { useSheetHeader } from "../navigation/useHeader";
import { useNav } from "../navigation/types";
import { listRegions, regionKeyForHub, regionProgress, saveRegion } from "../store/regions";
import { getRegionTree, type TreeNode } from "../sync/regionTree";
import { GroupHeader, Icon, InlineError, InsetGroup, ListRow, Note, Screen, Tap, TextField } from "../ui";
import { type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";

interface Checklist {
  name: string;
  items: {
    scientificName: string;
    commonName: string | null;
    taxonClass: string;
    tier: string | null;
    isVagrant: boolean;
    sensitiveByDefault: boolean;
    taxonOrder?: string | null;
    family?: string | null;
  }[];
}

/**
 * Which region the Collection shows: Everywhere first, the regions chosen lately, then the hub's country > group >
 * province tree to drill into (a flat list of the regions on the phone when there is no tree, as in standalone use).
 */
export function RegionPickerSheet({ route }: { route?: { params?: { at?: string } } }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const app = useApp();
  const nav = useNav();
  const { view, update } = useCollectionView();
  const [query, setQuery] = useState("");
  const [at, setAt] = useState<string | null>(route?.params?.at ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data } = useLocal(async (db) => {
    const regions = await listRegions(db);
    const progress = Object.fromEntries(
      await Promise.all(regions.map(async (r) => [r.key, await regionProgress(db, r.key)] as const)),
    );
    return { regions, progress, nodes: await getRegionTree(db) };
  });
  const tree = useMemo(() => (data?.nodes.length ? buildRegionTree(data.nodes) : null), [data]);
  useSheetHeader();

  const q = query.trim().toLowerCase();
  const all = useMemo(() => (data?.regions ?? []).filter((r) => !q || r.name.toLowerCase().includes(q)), [data, q]);
  const recent = useMemo(
    () =>
      q
        ? []
        : view.recent.map((k) => data?.regions.find((r) => r.key === k)).filter((r): r is NonNullable<typeof r> => !!r),
    [data, view.recent, q],
  );
  const choose = (region: string | null) => {
    update({ region });
    nav.goBack();
  };
  const row = (r: NonNullable<typeof data>["regions"][number], prefix: string) => (
    <ListRow
      key={`${prefix}${r.key}`}
      title={r.name}
      value={
        data
          ? t("regions.progress", { seen: data.progress[r.key]?.seen ?? 0, total: data.progress[r.key]?.total ?? 0 })
          : undefined
      }
      selected={view.region === r.key}
      onPress={() => choose(r.key)}
    />
  );

  // A region of the tree: kept on the phone already, or fetched from the hub first (its species list is small).
  const pick = async (node: TreeNode) => {
    const key = regionKeyForHub(node.id);
    if (!data?.regions.some((r) => r.key === key)) {
      if (!app.api) return;
      setBusy(node.id);
      setError(null);
      try {
        const list = await app.api.get<Checklist>(`/sync/regions/${node.id}/checklist`, 60_000);
        await saveRegion(
          app.db,
          { key, name: list.name, source: "hub", hubRegionId: node.id },
          list.items.map((i) => ({
            scientificName: i.scientificName,
            commonName: i.commonName,
            taxonClass: i.taxonClass,
            tier: i.tier,
            vagrant: i.isVagrant,
            sensitive: i.sensitiveByDefault,
            taxonOrder: i.taxonOrder,
            family: i.family,
          })),
          new Date(),
        );
        app.bump();
      } catch {
        setError(t("regions.failed"));
        return;
      } finally {
        setBusy(null);
      }
    }
    choose(key);
  };
  const open = (node: TreeNode) => {
    setQuery("");
    setAt(node.id);
  };
  const nodeRow = (node: TreeNode, subtitle?: string) => {
    const key = regionKeyForHub(node.id);
    const drills = (tree?.children(node.id).length ?? 0) > 0;
    const kept = data?.progress[key];
    return (
      <ListRow
        key={node.id}
        title={node.name}
        subtitle={subtitle}
        value={
          busy === node.id
            ? t("regions.downloading")
            : drills
              ? undefined
              : kept
                ? t("regions.progress", { seen: kept.seen, total: kept.total })
                : t("regions.speciesCount", { n: node.speciesCount })
        }
        selected={drills ? undefined : view.region === key}
        chevron={drills}
        onPress={() => (drills ? open(node) : void pick(node))}
      />
    );
  };

  if (tree) {
    const here = at ? tree.get(at) : undefined;
    const trail = at ? tree.trail(at) : [];
    const found = tree.search(query);
    const list = q ? found : here ? tree.children(here.id) : tree.top;
    const recentNodes = !q && !here ? recent : [];
    return (
      <Screen padded={false}>
        <View style={{ paddingHorizontal: 20, paddingTop: 8 }}>
          <TextField
            label={t("regions.searchLabel")}
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            returnKeyType="search"
          />
        </View>
        {error ? (
          <View style={{ paddingHorizontal: 20, paddingTop: 12 }}>
            <InlineError message={error} />
          </View>
        ) : null}
        {!q && here ? (
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              paddingHorizontal: 20,
              paddingTop: 12,
              alignItems: "center",
              gap: 4,
            }}
          >
            {[{ id: null as string | null, name: t("regionPicker.allRegions") }, ...trail].map((n, i, all) => (
              <View key={n.id ?? "top"} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                {i > 0 ? <Icon name="chevronRight" size={11} color={colors.muted} weight="bold" /> : null}
                <Tap
                  label={n.name}
                  hint={i < all.length - 1 ? t("regionPicker.crumbHint") : undefined}
                  disabled={i === all.length - 1}
                  onPress={() => setAt(n.id)}
                  style={{ minHeight: 44, justifyContent: "center" }}
                >
                  <Text
                    style={{
                      color: i === all.length - 1 ? colors.ink : colors.link,
                      fontSize: type.subheadline.size,
                      fontWeight: i === all.length - 1 ? "600" : "400",
                    }}
                  >
                    {n.name}
                  </Text>
                </Tap>
              </View>
            ))}
          </View>
        ) : null}
        {!q && !here ? (
          <View style={{ paddingTop: 16 }}>
            <InsetGroup>
              <ListRow
                title={t("collection.everywhere")}
                subtitle={t("regionPicker.everywhereLine")}
                leadingSize={22}
                leading={<Icon name="regions" size={22} color={colors.link} />}
                selected={view.region === null}
                onPress={() => choose(null)}
              />
            </InsetGroup>
          </View>
        ) : null}
        {recentNodes.length > 0 ? (
          <>
            <GroupHeader text={t("regionPicker.recent")} />
            <InsetGroup>{recentNodes.map((r) => row(r, "r"))}</InsetGroup>
          </>
        ) : null}
        {here && here.speciesCount > 0 && !q ? (
          <View style={{ paddingTop: 12 }}>
            <InsetGroup>
              <ListRow
                title={t("regionPicker.allOf", { name: here.name })}
                value={
                  busy === here.id ? t("regions.downloading") : t("regions.speciesCount", { n: here.speciesCount })
                }
                selected={view.region === regionKeyForHub(here.id)}
                onPress={() => void pick(here)}
              />
            </InsetGroup>
          </View>
        ) : null}
        {list.length > 0 ? (
          <>
            <GroupHeader
              text={
                q
                  ? t("regionPicker.results")
                  : here
                    ? t("regionPicker.within", { name: here.name })
                    : t("regionPicker.countries")
              }
            />
            <InsetGroup>
              {list.slice(0, 200).map((node) =>
                nodeRow(
                  node,
                  q
                    ? tree
                        .trail(node.id)
                        .slice(0, -1)
                        .map((x) => x.name)
                        .join(", ") || undefined
                    : undefined,
                ),
              )}
            </InsetGroup>
          </>
        ) : q ? (
          <View style={{ paddingHorizontal: 20, paddingTop: 16 }}>
            <Note text={t("regionPicker.noMatch", { query: query.trim() })} />
          </View>
        ) : null}
        <View style={{ height: 24 }} />
      </Screen>
    );
  }

  return (
    <Screen padded={false}>
      <View style={{ paddingHorizontal: 20, paddingTop: 8 }}>
        <TextField
          label={t("regions.searchLabel")}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          returnKeyType="search"
        />
      </View>
      {!q ? (
        <View style={{ paddingTop: 16 }}>
          <InsetGroup>
            <ListRow
              title={t("collection.everywhere")}
              subtitle={t("regionPicker.everywhereLine")}
              leadingSize={22}
              leading={<Icon name="regions" size={22} color={colors.link} />}
              selected={view.region === null}
              onPress={() => choose(null)}
            />
          </InsetGroup>
        </View>
      ) : null}
      {recent.length > 0 ? (
        <>
          <GroupHeader text={t("regionPicker.recent")} />
          <InsetGroup>{recent.map((r) => row(r, "r"))}</InsetGroup>
        </>
      ) : null}
      <GroupHeader text={t("regionPicker.onPhone")} />
      {all.length > 0 ? (
        <InsetGroup>{all.map((r) => row(r, "a"))}</InsetGroup>
      ) : (
        <View style={{ paddingHorizontal: 20 }}>
          <Note text={q ? t("regionPicker.noMatch", { query: query.trim() }) : t("regions.empty")} />
        </View>
      )}
      <View style={{ paddingTop: 16 }}>
        <InsetGroup>
          <ListRow
            title={t("regions.add")}
            leadingSize={22}
            leading={<Icon name="add" size={22} color={colors.link} weight="semibold" />}
            onPress={() => {
              nav.goBack();
              setTimeout(() => nav.navigate("AddRegion"), 350);
            }}
          />
        </InsetGroup>
      </View>
    </Screen>
  );
}
