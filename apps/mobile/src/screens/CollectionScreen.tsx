import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Text, View, useWindowDimensions } from "react-native";
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { useTranslation } from "react-i18next";
import { groupById, type GroupId } from "../theme/groups";
import { useApp, useLocal } from "../app/AppContext";
import {
  activeFilterCount,
  useCollectionView,
  type Arrange,
  type CardSize,
  type GroupBy,
  type Show,
} from "../collection/view";
import { filterSpecies, groupSpecies, sortSpecies } from "../collection/arrange";
import { useHeader, type MenuEntry } from "../navigation/useHeader";
import { useNav } from "../navigation/types";
import { Scrubber, type ScrubberHandle } from "../photos/Scrubber";
import { matchSpecies } from "../search/species";
import { listCollection, speciesPhotographedIn, type CollectionSpecies } from "../store/browse";
import { listRegions } from "../store/regions";
import { type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";
import { Button, EmptyState, Icon, ProgressBar, SectionHeader, SpeciesCard, SpeciesRow, Tap } from "../ui";
import { useSpeciesActions } from "./parts/useSpeciesActions";
import { ARRANGE_LABEL, GROUP_BY_LABEL, SIZE_LABEL, TIER_LABEL } from "../labels";

type Item =
  | { kind: "header"; key: string; group: GroupId; title: string; count: string; label: string; folded: boolean }
  | { kind: "cards"; key: string; rows: CollectionSpecies[] }
  | { kind: "row"; key: string; row: CollectionSpecies };

const SHOWS: Show[] = ["all", "photographed", "seen", "targets", "unseen"];
const SHOW_LABEL: Record<Show, string> = {
  all: "collection.showAll",
  photographed: "collection.showPhotographed",
  seen: "collection.showSeen",
  targets: "collection.showTargets",
  unseen: "collection.showUnseen",
};
const ARRANGES: Arrange[] = ["common", "scientific", "rarity", "photographedFirst", "seenFirst", "targetsFirst"];
const SIZES: CardSize[] = ["large", "small", "list"];
const GROUPS: GroupBy[] = ["broad", "none"];

const chunk = <T,>(rows: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += n) out.push(rows.slice(i, i + n));
  return out;
};

/** The Collection: the desktop's species cards for a region, grouped by broad group, searched and filtered. */
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

  // A region that was removed is no longer chosen.
  useEffect(() => {
    if (view.region && regions && !regions.some((r) => r.key === view.region)) update({ region: null });
  }, [view.region, regions, update]);

  const checks = <V extends string>(
    values: V[],
    current: V,
    label: (v: V) => string,
    set: (v: V) => void,
  ): MenuEntry[] =>
    values.map((v) => ({ type: "action", label: t(label(v)), checked: v === current, onPress: () => set(v) }));
  const filters = activeFilterCount(view);

  const scientificFirst = app.settings.nameOrder === "scientific";
  const progress = useMemo(
    () => ({ photographed: all?.filter((r) => r.status === "photographed").length ?? 0, total: all?.length ?? 0 }),
    [all],
  );
  const filtered = useMemo(() => (all ? filterSpecies(all, view, inYear ?? null) : []), [all, view, inYear]);
  const searching = deferred.trim().length > 0;
  const shown = useMemo(
    () => (searching ? matchSpecies(filtered, deferred) : sortSpecies(filtered, view.arrange)),
    [filtered, searching, deferred, view.arrange],
  );

  // At accessibility text sizes the grid falls back to List (names would not fit a card).
  const { fontScale } = useWindowDimensions();
  const accessible = fontScale > 1.3;
  const size: CardSize = accessible ? "list" : view.size;
  const columns = size === "small" ? 3 : 2;

  const sections = useMemo(
    () => (searching || view.group === "none" ? [] : groupSpecies(shown, all ?? [])),
    [shown, searching, view.group, all],
  );
  const folded = useMemo(() => new Set(view.collapsed), [view.collapsed]);
  const items = useMemo<Item[]>(() => {
    const cards = (rows: CollectionSpecies[], key: string): Item[] =>
      size === "list"
        ? rows.map((row) => ({ kind: "row", key: `${key}${row.scientificName}`, row }))
        : chunk(rows, columns).map((r, i) => ({ kind: "cards", key: `${key}${i}`, rows: r }));
    if (searching || view.group === "none") return cards(shown, "s");
    // A folded group keeps its header and drops its cards, so a 5,000 species list scrolls as a handful of rows.
    return sections.flatMap((s) => [
      {
        kind: "header" as const,
        key: `h${s.group}`,
        group: s.group,
        title: t(groupById(s.group).label),
        count: t("collection.groupCount", { done: s.photographed, total: s.total }),
        label: t("collection.groupLabel", { name: t(groupById(s.group).label), done: s.photographed, total: s.total }),
        folded: folded.has(s.group),
      },
      ...(folded.has(s.group) ? [] : cards(s.rows, s.group)),
    ]);
  }, [shown, searching, view.group, sections, folded, size, columns, t]);
  const setFolded = (ids: GroupId[]) => update({ collapsed: ids });
  const toggle = (g: GroupId) =>
    setFolded(folded.has(g) ? view.collapsed.filter((x) => x !== g) : [...view.collapsed, g]);
  // Jumping to a folded group opens it first, then scrolls once its rows exist.
  const jump = useRef<GroupId | null>(null);
  const goTo = (g: GroupId) => {
    jump.current = g;
    if (folded.has(g)) setFolded(view.collapsed.filter((x) => x !== g));
    else scrollToGroup();
  };
  const scrollToGroup = () => {
    const at = items.findIndex((it) => it.kind === "header" && it.group === jump.current);
    jump.current = null;
    if (at >= 0) void list.current?.scrollToIndex({ index: at, animated: true });
  };
  useEffect(() => {
    if (jump.current && !folded.has(jump.current)) scrollToGroup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const groupMenu: MenuEntry[] = [
    ...sections.map((s): MenuEntry => ({
      type: "action",
      label: t("collection.groupMenuItem", { name: t(groupById(s.group).label), n: s.rows.length }),
      checked: !folded.has(s.group),
      onPress: () => goTo(s.group),
    })),
    {
      type: "submenu",
      label: t("collection.foldAll"),
      inline: true,
      items: [
        { type: "action", label: t("collection.collapseAll"), onPress: () => setFolded(sections.map((s) => s.group)) },
        { type: "action", label: t("collection.expandAll"), onPress: () => setFolded([]) },
      ],
    },
  ];

  useHeader({
    title: t("tabs.collection"),
    search: { placeholder: t("collection.searchPlaceholder"), onChange: setQuery },
    items: [
      {
        type: "menu",
        key: "filter",
        label: t("collection.menu"),
        icon: "filter",
        items: [
          {
            type: "submenu",
            label: t("collection.show"),
            inline: true,
            items: checks(
              SHOWS,
              view.show,
              (v) => SHOW_LABEL[v],
              (show) => update({ show }),
            ),
          },
          {
            type: "submenu",
            label: t("collection.arrange"),
            description: t(ARRANGE_LABEL[view.arrange]),
            items: checks(
              ARRANGES,
              view.arrange,
              (v) => ARRANGE_LABEL[v],
              (arrange) => update({ arrange }),
            ),
          },
          {
            type: "submenu",
            label: t("collection.group"),
            description: t(GROUP_BY_LABEL[view.group]),
            items: checks(
              GROUPS,
              view.group,
              (v) => GROUP_BY_LABEL[v],
              (group) => update({ group }),
            ),
          },
          {
            type: "submenu",
            label: t("collection.cardSize"),
            description: t(SIZE_LABEL[view.size]),
            items: checks(
              SIZES,
              view.size,
              (v) => SIZE_LABEL[v],
              (size) => update({ size }),
            ),
          },
          {
            type: "action",
            label: t("collection.moreFilters"),
            icon: "sliders",
            onPress: () => nav.navigate("MoreFilters"),
          },
        ],
      },
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
  // The index down the right edge: groups, or letters when arranged by name. Only for long lists.
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
  const sticky = useMemo(() => items.flatMap((it, i) => (it.kind === "header" ? [i] : [])), [items]);

  const regionName = view.region
    ? (regions?.find((r) => r.key === view.region)?.name ?? t("collection.everywhere"))
    : t("collection.everywhere");
  const summary = [
    view.show !== "all" ? t(SHOW_LABEL[view.show]) : null,
    view.tiers.length ? view.tiers.map((x) => t(TIER_LABEL[x])).join(", ") : null,
    view.vagrants ? null : t("collection.noVagrants"),
    view.year,
  ]
    .filter(Boolean)
    .join(", ");

  const open = (scientificName: string) => nav.navigate("Species", { scientificName });
  const cardWidthPad = 16;

  const header = (
    <View>
      <Tap
        label={t("collection.regionLabel", { region: regionName })}
        hint={t("collection.regionHint")}
        onPress={() => nav.navigate("RegionPicker")}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 20, minHeight: 44 }}>
          <Text style={{ flexShrink: 1, color: colors.link, fontSize: type.headline.size, fontWeight: "600" }}>
            {regionName}
          </Text>
          <Icon name="chevronDown" size={13} color={colors.link} weight="bold" />
        </View>
      </Tap>
      {all && all.length > 0 ? (
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

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <FlashList
        data={items}
        keyExtractor={(i) => i.key}
        getItemType={(i) => i.kind}
        stickyHeaderIndices={sticky}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ref={list}
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
            <SectionHeader
              title={item.title}
              count={item.count}
              group={item.group}
              label={item.label}
              collapsed={item.folded}
              onToggle={() => toggle(item.group)}
              hint={t(item.folded ? "collection.expandHint" : "collection.collapseHint")}
            />
          ) : item.kind === "row" ? (
            <SpeciesRow
              row={item.row}
              onPress={open}
              actions={actions.actions}
              onLongPress={onLongPress}
              scientificFirst={scientificFirst}
            />
          ) : (
            <View style={{ flexDirection: "row", gap: 12, paddingHorizontal: cardWidthPad, paddingBottom: 12 }}>
              {item.rows.map((row) => (
                <SpeciesCard
                  key={row.scientificName}
                  row={row}
                  onPress={open}
                  actions={actions.actions}
                  onLongPress={onLongPress}
                  allTiers={view.arrange === "rarity"}
                  scientificFirst={scientificFirst}
                  hideNames={size === "small"}
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
