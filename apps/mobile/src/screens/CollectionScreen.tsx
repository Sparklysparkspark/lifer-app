import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Text, View, useWindowDimensions } from "react-native";
import { FlashList, type FlashListRef, type ViewToken } from "@shopify/flash-list";
import { useTranslation } from "react-i18next";
import { useApp, useLocal } from "../app/AppContext";
import { activeFilterCount, useCollectionView, type Arrange, type CardSize, type GroupBy } from "../collection/view";
import {
  countsAsPhotographed,
  filterSpecies,
  firstSpecies,
  groupSpecies,
  indexOfSpecies,
  sortSpecies,
  type Section,
} from "../collection/arrange";
import { choices, toggle, viewAndFilters } from "../collection/viewBar";
import { useHeader, type MenuEntry } from "../navigation/useHeader";
import { useNav } from "../navigation/types";
import { Scrubber, type ScrubberHandle } from "../photos/Scrubber";
import { matchSpecies } from "../search/species";
import { listCollection, photographedWhere, speciesPhotographedIn, type CollectionSpecies } from "../store/browse";
import { listRegions } from "../store/regions";
import { type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";
import { Button, EmptyState, GroupBand, Icon, ProgressBar, SectionHeader, SpeciesCard, SpeciesRow, Tap } from "../ui";
import { CARD_MIN, GRID_GAP, GRID_PAD } from "../ui/sizeClass";
import { useSizeClass } from "../ui/useSizeClass";
import { useSpeciesActions } from "./parts/useSpeciesActions";
import { SHOW_LABEL } from "./FiltersSheet";
import { ARRANGE_LABEL, GROUP_BY_LABEL, SIZE_LABEL, TIER_LABEL } from "../labels";

type Item =
  | { kind: "header"; key: string; section: Section; title: string; label: string; folded: boolean; band: boolean }
  | { kind: "cards"; key: string; rows: CollectionSpecies[] }
  | { kind: "row"; key: string; row: CollectionSpecies };

const ARRANGES: Arrange[] = [
  "fieldGuide",
  "common",
  "scientific",
  "rarity",
  "photographedFirst",
  "seenFirst",
  "targetsFirst",
];
const SIZES: CardSize[] = ["large", "small", "list"];
const GROUPS: GroupBy[] = ["broad", "family", "none"];

const chunk = <T,>(rows: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += n) out.push(rows.slice(i, i + n));
  return out;
};

/** The Collection: the desktop's species cards for a region, grouped, searched, with View and Filters. */
export function CollectionScreen() {
  const { t } = useTranslation();
  const app = useApp();
  const nav = useNav();
  const { colors } = useTheme();
  const { view, update, clearFilters } = useCollectionView();
  const actions = useSpeciesActions();
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);

  const { data: all, loading } = useLocal((db) => listCollection(db, view.region), [view.region]);
  const { data: regions } = useLocal(listRegions);
  const { data: inYear } = useLocal(
    async (db) => (view.year ? speciesPhotographedIn(db, view.year) : null),
    [view.year],
  );
  const region = view.region ? regions?.find((r) => r.key === view.region) : undefined;
  // Photos taken needs the hub's region ids; a standalone list has none, so it is not offered there.
  const hubRegion = region?.hubRegionId ?? null;
  const taken = hubRegion ? view.photosTaken : "anywhere";
  const { data: places } = useLocal(
    async (db) => (hubRegion && taken !== "anywhere" ? photographedWhere(db, hubRegion) : null),
    [hubRegion, taken],
  );

  // A region that was removed is no longer chosen.
  useEffect(() => {
    if (view.region && regions && !regions.some((r) => r.key === view.region)) update({ region: null });
  }, [view.region, regions, update]);

  const filters = activeFilterCount({ ...view, photosTaken: taken });
  const scientificFirst = app.settings.nameOrder === "scientific";
  const counts = useMemo(
    () => (r: CollectionSpecies) => countsAsPhotographed(r, taken, places ?? null),
    [taken, places],
  );
  const progress = useMemo(
    () => ({ photographed: all?.filter(counts).length ?? 0, total: all?.length ?? 0 }),
    [all, counts],
  );
  const filtered = useMemo(
    () => (all ? filterSpecies(all, { ...view, photosTaken: taken }, inYear ?? null, places ?? null) : []),
    [all, view, taken, inYear, places],
  );
  const searching = deferred.trim().length > 0;
  const shown = useMemo(
    () => (searching ? matchSpecies(filtered, deferred) : sortSpecies(filtered, view.arrange)),
    [filtered, searching, deferred, view.arrange],
  );

  // At accessibility text sizes the grid falls back to List (names would not fit a card).
  const { fontScale } = useWindowDimensions();
  const sizes = useSizeClass();
  const size: CardSize = fontScale > 1.3 ? "list" : view.size;
  const columns = size === "list" ? 1 : sizes.columns(CARD_MIN[size]);

  const sections = useMemo(
    () => (searching || view.group === "none" ? [] : groupSpecies(shown, all ?? [], view.group, counts)),
    [shown, searching, view.group, all, counts],
  );
  const bands = view.showGroupProgress && view.group === "broad";
  const folded = useMemo(() => new Set(view.collapsed), [view.collapsed]);
  const items = useMemo<Item[]>(() => {
    const cards = (rows: CollectionSpecies[], key: string): Item[] =>
      size === "list"
        ? rows.map((row) => ({ kind: "row", key: `${key}${row.scientificName}`, row }))
        : chunk(rows, columns).map((r, i) => ({ kind: "cards", key: `${key}${i}`, rows: r }));
    if (searching || view.group === "none") return cards(shown, "s");
    // A folded section keeps its header and drops its cards, so a 5,000 species list scrolls as a handful of rows.
    return sections.flatMap((s) => {
      const title = "key" in s.title ? t(s.title.key) : s.title.name;
      return [
        {
          kind: "header" as const,
          key: `h${s.key}`,
          section: s,
          title,
          label: t("collection.groupLabel", { name: title, done: s.photographed, total: s.total }),
          folded: folded.has(s.key),
          band: bands,
        },
        ...(folded.has(s.key) ? [] : cards(s.rows, s.key)),
      ];
    });
  }, [shown, searching, view.group, sections, folded, size, columns, bands, t]);
  const setFolded = (keys: string[]) => update({ collapsed: keys });
  const toggleFold = (k: string) =>
    setFolded(folded.has(k) ? view.collapsed.filter((x) => x !== k) : [...view.collapsed, k]);
  // Jumping to a folded section opens it first, then scrolls once its rows exist.
  const jump = useRef<string | null>(null);
  const goTo = (k: string) => {
    jump.current = k;
    if (folded.has(k)) setFolded(view.collapsed.filter((x) => x !== k));
    else scrollToSection();
  };
  const scrollToSection = () => {
    const at = items.findIndex((it) => it.kind === "header" && it.section.key === jump.current);
    jump.current = null;
    if (at >= 0) void list.current?.scrollToIndex({ index: at, animated: true });
  };

  // F-4: when the columns change (card size, a rotation, a fold opening) the first species in view stays in view.
  const firstVisible = useRef<string | null>(null);
  const onViewable = useRef(({ viewableItems }: { viewableItems: ViewToken<Item>[] }) => {
    firstVisible.current = firstSpecies(viewableItems.find((v) => v.item.kind !== "header")?.item);
  }).current;
  const layout = useRef(`${size}:${columns}`);
  useEffect(() => {
    if (jump.current && !folded.has(jump.current)) return scrollToSection();
    if (layout.current === `${size}:${columns}`) return;
    layout.current = `${size}:${columns}`;
    const at = indexOfSpecies(items, firstVisible.current);
    if (at > 0) void list.current?.scrollToIndex({ index: at, animated: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const viewMenu: MenuEntry[] = [
    {
      type: "submenu",
      label: t("collection.arrange"),
      description: t(ARRANGE_LABEL[view.arrange]),
      items: choices(
        ARRANGES,
        view.arrange,
        (v) => t(ARRANGE_LABEL[v]),
        (arrange) => update({ arrange }),
      ),
    },
    {
      type: "submenu",
      label: t("collection.group"),
      description: t(GROUP_BY_LABEL[view.group]),
      items: choices(
        GROUPS,
        view.group,
        (v) => t(GROUP_BY_LABEL[v]),
        (group) => update({ group, collapsed: [] }),
      ),
    },
    {
      type: "submenu",
      label: t("collection.cardSize"),
      description: t(SIZE_LABEL[view.size]),
      items: choices(
        SIZES,
        view.size,
        (v) => t(SIZE_LABEL[v]),
        (s) => update({ size: s }),
      ),
    },
    {
      // Unnamed inline section: the switches sit under a separator, as on the desktop.
      type: "submenu",
      label: "",
      inline: true,
      items: [
        toggle(t("collection.showRarityTags"), view.showRarityTags, (showRarityTags) => update({ showRarityTags })),
        toggle(t("collection.showGroupProgress"), view.showGroupProgress, (showGroupProgress) =>
          update({ showGroupProgress }),
        ),
        toggle(t("collection.uncollectedColour"), view.uncollectedColour, (uncollectedColour) =>
          update({ uncollectedColour }),
        ),
        toggle(t("collection.hideNames"), view.hideNames, (hideNames) => update({ hideNames })),
      ],
    },
  ];
  const groupMenu: MenuEntry[] = [
    ...items.flatMap((it): MenuEntry[] =>
      it.kind === "header"
        ? [
            {
              type: "action",
              label: t("collection.groupMenuItem", { name: it.title, n: it.section.rows.length }),
              checked: !it.folded,
              onPress: () => goTo(it.section.key),
            },
          ]
        : [],
    ),
    {
      type: "submenu",
      label: t("collection.foldAll"),
      inline: true,
      items: [
        { type: "action", label: t("collection.collapseAll"), onPress: () => setFolded(sections.map((s) => s.key)) },
        { type: "action", label: t("collection.expandAll"), onPress: () => setFolded([]) },
      ],
    },
  ];

  useHeader({
    title: t("tabs.collection"),
    search: { placeholder: t("collection.searchPlaceholder"), onChange: setQuery },
    items: [
      ...viewAndFilters(t, viewMenu, filters, () => nav.navigate("Filters", { scope: "collection" })),
      ...(sections.length > 1
        ? [
            {
              type: "menu" as const,
              key: "groups",
              label: t("collection.groups"),
              icon: "collection" as const,
              items: groupMenu,
            },
          ]
        : []),
    ],
  });
  // The index down the right edge: sections, or letters when arranged by name. Only for long lists.
  const marks = useMemo(() => {
    if (searching || items.length < 40) return [];
    const out: { label: string; index: number }[] = [];
    items.forEach((it, i) => {
      if (it.kind === "header") out.push({ label: it.title, index: i });
      else if (view.group === "none" && (view.arrange === "common" || view.arrange === "scientific")) {
        const r = it.kind === "cards" ? it.rows[0] : it.row;
        const letter = (
          (view.arrange === "common" ? (r.commonName ?? r.scientificName) : r.scientificName)[0] ?? "#"
        ).toUpperCase();
        if (out.at(-1)?.label !== letter) out.push({ label: letter, index: i });
      }
    });
    return out;
  }, [items, searching, view.group, view.arrange]);
  const list = useRef<FlashListRef<Item>>(null);
  const scrubber = useRef<ScrubberHandle>(null);
  const position = useRef(0);
  const at = (f: number) => marks[Math.min(marks.length - 1, Math.max(0, Math.round(f * (marks.length - 1))))];
  // Bands are too tall to pin; plain section headers stay at the top while their species scroll.
  const sticky = useMemo(() => items.flatMap((it, i) => (it.kind === "header" && !it.band ? [i] : [])), [items]);

  const regionName = region?.name ?? null;
  const shownRegion = regionName ?? t("collection.everywhere");
  const summary = [
    view.show !== "all" ? t(SHOW_LABEL[view.show]) : null,
    taken === "here" && regionName ? t("filters.inRegion", { region: regionName }) : null,
    taken === "elsewhere" && regionName ? t("filters.outside", { region: regionName }) : null,
    view.tiers.length ? view.tiers.map((x) => t(TIER_LABEL[x])).join(", ") : null,
    view.vagrant === "only" ? t("filters.vagrantsOnly") : view.vagrant === "hide" ? t("filters.vagrantsHide") : null,
    view.needsBetter ? t("species.needsBetter") : null,
    view.year,
  ]
    .filter(Boolean)
    .join(", ");

  const open = (scientificName: string) => nav.navigate("Species", { scientificName });

  const header = (
    <View>
      <Tap
        label={t("collection.regionLabel", { region: shownRegion })}
        hint={t("collection.regionHint")}
        onPress={() => nav.navigate("RegionPicker")}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 20, minHeight: 44 }}>
          <Text style={{ flexShrink: 1, color: colors.link, fontSize: type.headline.size, fontWeight: "600" }}>
            {shownRegion}
          </Text>
          <Icon name="chevronDown" size={13} color={colors.link} weight="bold" />
        </View>
      </Tap>
      {all && all.length > 0 && !bands ? (
        <Tap
          label={t("collection.progressLabel", { done: progress.photographed, total: progress.total })}
          hint={t("collection.progressHint")}
          onPress={() => nav.navigate("Stats")}
        >
          <View style={{ paddingHorizontal: 20, paddingTop: 4, gap: 8 }}>
            <Text style={{ color: colors.muted, fontSize: type.footnote.size }}>
              {t("collection.progress", { done: progress.photographed, total: progress.total })}
            </Text>
            <ProgressBar
              fraction={progress.total ? progress.photographed / progress.total : 0}
              label={t("collection.progress", { done: progress.photographed, total: progress.total })}
            />
          </View>
        </Tap>
      ) : null}
      {filters > 0 ? (
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingTop: 10, gap: 8 }}>
          <Text style={{ flex: 1, color: colors.muted, fontSize: type.footnote.size }}>{summary}</Text>
          <Button variant="plain" compact label={t("collection.clearFilters")} onPress={clearFilters} />
        </View>
      ) : null}
      {searching ? (
        <Text style={{ color: colors.muted, fontSize: type.footnote.size, paddingHorizontal: 20, paddingTop: 12 }}>
          {t("collection.matches", { n: shown.length })}
        </Text>
      ) : null}
      <View style={{ height: 12 }} />
    </View>
  );

  const empty =
    !all?.length && !loading ? (
      <EmptyState
        icon="collection"
        title={t("collection.emptyTitle")}
        line={t("collection.emptyLine")}
        action={{ label: t("collection.emptyAction"), onPress: () => nav.navigate("RegionPicker") }}
      />
    ) : all && shown.length === 0 ? (
      <EmptyState
        icon="search"
        title={searching ? t("collection.noMatch", { query: deferred.trim() }) : t("collection.nothingHere")}
        line={filters > 0 ? t("collection.nothingHereLine") : undefined}
        action={filters > 0 ? { label: t("collection.clearFilters"), onPress: clearFilters } : undefined}
      />
    ) : null;

  const onLongPress = (row: CollectionSpecies) => actions.menu(row);
  const spacer = (n: number) => Array.from({ length: n }, (_, i) => <View key={`pad${i}`} style={{ flex: 1 }} />);
  const bandPhotos = (s: Section) =>
    s.rows.flatMap((r) => (r.status === "photographed" && r.coverPhotoId ? [r.coverPhotoId] : [])).slice(0, 3);

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <FlashList
        data={items}
        keyExtractor={(i) => i.key}
        getItemType={(i) => (i.kind === "header" && i.band ? "band" : i.kind)}
        stickyHeaderIndices={sticky}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ref={list}
        onViewableItemsChanged={onViewable}
        onScroll={(e) => {
          const n = e.nativeEvent;
          position.current = Math.max(
            0,
            Math.min(1, n.contentOffset.y / Math.max(1, n.contentSize.height - n.layoutMeasurement.height)),
          );
          scrubber.current?.follow(position.current);
        }}
        scrollEventThrottle={32}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        onRefresh={app.mode === "paired" ? () => void app.sync.run() : undefined}
        refreshing={app.sync.syncing}
        contentContainerStyle={{ paddingBottom: 24 }}
        renderItem={({ item }) =>
          item.kind === "header" ? (
            item.band ? (
              <GroupBand
                title={item.title}
                group={item.section.group}
                photographed={item.section.photographed}
                total={item.section.total}
                count={t("collection.bandCount", { n: item.section.photographed })}
                ofTotal={t("collection.ofTotal", { total: item.section.total })}
                photoIds={bandPhotos(item.section)}
                label={item.label}
                hint={t(item.folded ? "collection.expandHint" : "collection.collapseHint")}
                onToggle={() => toggleFold(item.section.key)}
              />
            ) : (
              <SectionHeader
                title={item.title}
                count={t("collection.groupCount", { done: item.section.photographed, total: item.section.total })}
                group={item.section.group}
                label={item.label}
                collapsed={item.folded}
                onToggle={() => toggleFold(item.section.key)}
                hint={t(item.folded ? "collection.expandHint" : "collection.collapseHint")}
              />
            )
          ) : item.kind === "row" ? (
            <SpeciesRow
              row={item.row}
              onPress={open}
              actions={actions.actions}
              onLongPress={onLongPress}
              scientificFirst={scientificFirst}
              region={regionName}
              showRarityTags={view.showRarityTags}
            />
          ) : (
            <View style={{ flexDirection: "row", gap: GRID_GAP, paddingHorizontal: GRID_PAD, paddingBottom: GRID_GAP }}>
              {item.rows.map((row) => (
                <SpeciesCard
                  key={row.scientificName}
                  row={row}
                  onPress={open}
                  actions={actions.actions}
                  onLongPress={onLongPress}
                  region={regionName}
                  showRarityTags={view.showRarityTags}
                  uncollectedColour={view.uncollectedColour}
                  scientificFirst={scientificFirst}
                  hideNames={view.hideNames}
                />
              ))}
              {spacer(columns - item.rows.length)}
            </View>
          )
        }
      />
      {marks.length > 1 ? (
        <Scrubber
          ref={scrubber}
          label={t("collection.index")}
          bubble={(f) => at(f).label}
          onScrub={(f) => void list.current?.scrollToIndex({ index: at(f).index, animated: false })}
          onStep={(dir) => {
            const now = marks.indexOf(at(position.current));
            const next = marks[Math.max(0, Math.min(marks.length - 1, now + dir))];
            void list.current?.scrollToIndex({ index: next.index, animated: true });
          }}
        />
      ) : null}
    </View>
  );
}
