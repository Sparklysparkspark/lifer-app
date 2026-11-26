import { useState, type ReactElement } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { TIER_ORDER } from "@lifer/shared";
import { useLocal } from "../app/AppContext";
import { activeFilterCount, galleryFilterCount, useCollectionView, type Show, type Trait } from "../collection/view";
import { useHeader } from "../navigation/useHeader";
import { useNav, type RootParams } from "../navigation/types";
import { photoYears } from "../store/browse";
import { listTrips } from "../store/library";
import { listRegions } from "../store/regions";
import { GROUP_ORDER, groupById, type GroupId } from "../theme/groups";
import { useTheme } from "../theme/useTheme";
import { Button, GroupFooter, GroupHeader, InsetGroup, ListRow, Screen, Segmented, SwitchRow } from "../ui";
import { TIER_LABEL } from "../labels";

const SHOWS: Show[] = ["all", "photographed", "seen", "targets", "unseen"];
export const SHOW_LABEL: Record<Show, string> = {
  all: "collection.showAll",
  photographed: "collection.showPhotographed",
  seen: "collection.showSeen",
  targets: "collection.showTargets",
  unseen: "collection.showUnseen",
};
const TRAITS: Trait[] = ["any", "only", "hide"];
const TRAIT_LABEL = { any: "filters.any", only: "filters.only", hide: "filters.hide" } as const;
const TIERS = [...TIER_ORDER, "unrated"];
const NAMED_GROUPS = GROUP_ORDER.filter((g) => g !== "other");

/**
 * The one Filters sheet, for the Collection or the Gallery: what to show, as the desktop's Filters. Choices
 * apply at once and are remembered; Clear empties them, Done closes. A row with a value opens its choices in place.
 */
export function FiltersSheet({ route }: { route: { params: RootParams["Filters"] } }) {
  const { t } = useTranslation();
  const nav = useNav();
  const { colors } = useTheme();
  const v = useCollectionView();
  const gallery = route.params.scope === "gallery";
  const [open, setOpen] = useState<string | null>(null);
  const { data: facets } = useLocal(async (db) => ({
    years: await photoYears(db),
    regions: gallery ? [] : await listRegions(db),
    trips: gallery ? await listTrips(db, new Date().toISOString().slice(0, 10)) : [],
  }));
  const count = gallery ? galleryFilterCount(v.gallery) : activeFilterCount(v.view);
  useHeader({
    noAccount: true,
    items: [
      {
        type: "button",
        key: "done",
        label: t("common.done"),
        onPress: () => nav.goBack(),
        prominent: true,
        tint: colors.accent,
      },
    ],
    options: {
      headerLeft: () => (
        <Button
          variant="plain"
          compact
          label={t("common.clear")}
          disabled={count === 0}
          onPress={gallery ? v.clearGalleryFilters : v.clearFilters}
        />
      ),
    },
  });

  /** A row naming its current value; pressed, it lists its choices under it with checkmarks. */
  function choice<V>(
    id: string,
    title: string,
    value: string,
    options: { value: V; label: string }[],
    on: (x: V) => boolean,
    pick: (x: V) => void,
  ): ReactElement[] {
    const head = (
      <ListRow key={id} title={title} value={value} chevron onPress={() => setOpen(open === id ? null : id)} />
    );
    if (open !== id) return [head];
    return [
      head,
      ...options.map((o) => (
        <ListRow
          key={`${id}:${o.label}`}
          title={o.label}
          leading={<View style={{ width: 12 }} />}
          leadingSize={12}
          selected={on(o.value)}
          onPress={() => pick(o.value)}
        />
      )),
    ];
  }
  const anyYear = t("filters.anyYear");
  const years = [
    { value: null as string | null, label: anyYear },
    ...(facets?.years ?? []).map((y) => ({ value: y, label: y })),
  ];

  if (gallery) {
    const g = v.gallery;
    const set = v.updateGallery;
    const groupName = (id: GroupId | null) => (id ? t(groupById(id).label) : t("gallery.allGroups"));
    const tripName = (id: string | null) => facets?.trips.find((x) => x.id === id)?.name ?? t("gallery.allTrips");
    return (
      <Screen padded={false}>
        <GroupHeader text={t("gallery.show")} />
        <InsetGroup>
          <ListRow title={t("gallery.allPhotos")} selected={!g.featured} onPress={() => set({ featured: false })} />
          <ListRow title={t("gallery.featured")} selected={g.featured} onPress={() => set({ featured: true })} />
        </InsetGroup>
        <View style={{ height: 20 }} />
        <InsetGroup>
          {choice<GroupId | null>(
            "group",
            t("gallery.group"),
            groupName(g.group),
            [null, ...NAMED_GROUPS].map((x) => ({ value: x, label: groupName(x) })),
            (x) => x === g.group,
            (group) => set({ group }),
          )}
          {choice<string | null>(
            "trip",
            t("gallery.trip"),
            tripName(g.trip),
            [null, ...(facets?.trips ?? []).map((x) => x.id)].map((x) => ({ value: x, label: tripName(x) })),
            (x) => x === g.trip,
            (trip) => set({ trip }),
          )}
        </InsetGroup>
        <GroupHeader text={t("filters.when")} />
        <InsetGroup>
          {choice(
            "year",
            t("gallery.year"),
            g.year ?? anyYear,
            years,
            (x) => x === g.year,
            (year) => set({ year }),
          )}
        </InsetGroup>
        <View style={{ height: 32 }} />
      </Screen>
    );
  }

  const c = v.view;
  const set = v.update;
  const region = c.region ? facets?.regions.find((r) => r.key === c.region) : null;
  const tiersText = c.tiers.length ? c.tiers.map((x) => t(TIER_LABEL[x])).join(", ") : t("filters.any");
  return (
    <Screen padded={false}>
      <GroupHeader text={t("collection.show")} />
      <InsetGroup>
        {SHOWS.map((s) => (
          <ListRow key={s} title={t(SHOW_LABEL[s])} selected={c.show === s} onPress={() => set({ show: s })} />
        ))}
      </InsetGroup>
      {region?.hubRegionId ? (
        <>
          <GroupHeader text={t("filters.photosTaken")} />
          <InsetGroup>
            <ListRow
              title={t("filters.anywhere")}
              selected={c.photosTaken === "anywhere"}
              onPress={() => set({ photosTaken: "anywhere" })}
            />
            <ListRow
              title={t("filters.inRegion", { region: region.name })}
              selected={c.photosTaken === "here"}
              onPress={() => set({ photosTaken: "here" })}
            />
            <ListRow
              title={t("filters.outside", { region: region.name })}
              selected={c.photosTaken === "elsewhere"}
              onPress={() => set({ photosTaken: "elsewhere" })}
            />
          </InsetGroup>
          <GroupFooter text={t("filters.photosTakenNote")} />
        </>
      ) : null}
      <GroupHeader text={t("filters.traits")} />
      <InsetGroup>
        <ListRow
          title={t("filters.vagrants")}
          accessory={
            <Segmented
              inline
              label={t("filters.vagrants")}
              values={TRAITS.map((x) => t(TRAIT_LABEL[x]))}
              selected={TRAITS.indexOf(c.vagrant)}
              onChange={(i) => set({ vagrant: TRAITS[i] })}
            />
          }
        />
        {choice(
          "rarity",
          t(c.region ? "filters.rarityHere" : "filters.rarity"),
          tiersText,
          TIERS.map((x) => ({ value: x, label: t(TIER_LABEL[x]) })),
          (x) => c.tiers.includes(x),
          (x) => set({ tiers: c.tiers.includes(x) ? c.tiers.filter((y) => y !== x) : [...c.tiers, x] }),
        )}
        <SwitchRow
          label={t("species.needsBetter")}
          value={c.needsBetter}
          onChange={(needsBetter) => set({ needsBetter })}
        />
      </InsetGroup>
      <GroupHeader text={t("filters.when")} />
      <InsetGroup>
        {choice(
          "year",
          t("filters.year"),
          c.year ?? anyYear,
          years,
          (x) => x === c.year,
          (year) => set({ year }),
        )}
      </InsetGroup>
      <View style={{ height: 32 }} />
    </Screen>
  );
}
