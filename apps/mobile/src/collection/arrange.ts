// Pure rules for the Collection: filter, order and group the species rows. No React, so it is unit tested.
import { compareFieldGuideOrder, TIER_ORDER } from "@lifer/shared";
import { GROUP_ORDER, groupById, groupOf, type GroupId } from "../theme/groups";
import type { CollectionSpecies } from "../store/browse";
import { familyGroup } from "./families";
import type { Arrange, CollectionView, GroupBy, PhotosTaken } from "./model";

const STATUS_RANK = { photographed: 0, seen: 1, none: 2 } as const;
// Species with no tier sort after every tiered one.
const tierRank = (t: string | null) => TIER_ORDER.indexOf(t as never);
const name = (r: CollectionSpecies) => r.commonName ?? r.scientificName;
const byName = (a: CollectionSpecies, b: CollectionSpecies) =>
  name(a).localeCompare(name(b), undefined, { sensitivity: "base" });
const byScientific = (a: CollectionSpecies, b: CollectionSpecies) =>
  a.scientificName.localeCompare(b.scientificName, undefined, { sensitivity: "base" });

const ORDER: Record<Arrange, (a: CollectionSpecies, b: CollectionSpecies) => number> = {
  // Class, bird order, order and family as the desktop; within a family by scientific name, so genera stay together.
  fieldGuide: (a, b) => compareFieldGuideOrder(a, b) || byScientific(a, b),
  common: byName,
  scientific: byScientific,
  // Rarest first: the species hardest to find lead.
  rarity: (a, b) => tierRank(b.tier) - tierRank(a.tier) || byName(a, b),
  photographedFirst: (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || byName(a, b),
  seenFirst: (a, b) =>
    Number(b.status === "seen") - Number(a.status === "seen") ||
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    byName(a, b),
  targetsFirst: (a, b) => Number(b.isTarget) - Number(a.isTarget) || byName(a, b),
};

/** Where each photographed species' photos were taken, for Photos taken; null when no region narrows it. */
export type Places = Map<string, "here" | "elsewhere"> | null;

/** Whether a row counts as photographed under Photos taken (photos with no place count only under Anywhere). */
export const countsAsPhotographed = (r: CollectionSpecies, taken: PhotosTaken, places: Places): boolean =>
  r.status === "photographed" && (taken === "anywhere" || !places || places.get(r.scientificName) === taken);

/** The Filters sheet applied to a region's species. */
export function filterSpecies(
  rows: CollectionSpecies[],
  v: CollectionView,
  inYear: Set<string> | null,
  places: Places = null,
): CollectionSpecies[] {
  return rows.filter((r) => {
    if (v.show === "photographed" && r.status !== "photographed") return false;
    if (v.show === "seen" && r.status !== "seen") return false;
    if (v.show === "targets" && !r.isTarget) return false;
    if (v.show === "unseen" && r.status !== "none") return false;
    // Species without a photo stay with the Show filter.
    if (r.status === "photographed" && !countsAsPhotographed(r, v.photosTaken, places)) return false;
    if (v.tiers.length && !v.tiers.includes(r.tier ?? "unrated")) return false;
    if (v.vagrant === "only" && !r.vagrant) return false;
    if (v.vagrant === "hide" && r.vagrant) return false;
    if (v.needsBetter && !r.needsBetterPhoto) return false;
    if (v.year && !inYear?.has(r.scientificName)) return false;
    return true;
  });
}

export const sortSpecies = (rows: CollectionSpecies[], arrange: Arrange): CollectionSpecies[] =>
  [...rows].sort(ORDER[arrange]);

export interface Section {
  /** Stable id for folding: the broad group id, or "f:" and the family group. */
  key: string;
  /** A locale key ("groups.birds", "familyGroups.owls") or, for a family with no friendly name, the family itself. */
  title: { key: string } | { name: string };
  /** The broad group, for the glyph. */
  group: GroupId;
  rows: CollectionSpecies[];
  /** Species of this section that count as photographed, out of all its species in the region. */
  photographed: number;
  total: number;
}

const sectionOf = (r: CollectionSpecies, by: Exclude<GroupBy, "none">): Pick<Section, "key" | "title" | "group"> => {
  const group = groupOf(r.taxonClass).id;
  if (by === "broad") return { key: group, title: { key: groupById(group).label }, group };
  const title = familyGroup(r.taxonClass, r.family);
  return { key: `f:${"key" in title ? title.key : title.name}`, title, group };
};

/**
 * Rows split into sections, empty ones left out. Broad groups keep the fixed group order; family groups
 * come in field guide order, each where its earliest species would, with Other last.
 */
export function groupSpecies(
  rows: CollectionSpecies[],
  all: CollectionSpecies[],
  by: Exclude<GroupBy, "none"> = "broad",
  photographed: (r: CollectionSpecies) => boolean = (r) => r.status === "photographed",
): Section[] {
  const totals = new Map<string, { photographed: number; total: number }>();
  for (const r of all) {
    const k = sectionOf(r, by).key;
    const t = totals.get(k) ?? { photographed: 0, total: 0 };
    t.total++;
    if (photographed(r)) t.photographed++;
    totals.set(k, t);
  }
  const bySection = new Map<string, Section>();
  for (const r of rows) {
    const s = sectionOf(r, by);
    const at = bySection.get(s.key) ?? { ...s, rows: [], ...(totals.get(s.key) ?? { photographed: 0, total: 0 }) };
    at.rows.push(r);
    bySection.set(s.key, at);
  }
  const sections = [...bySection.values()];
  if (by === "broad") return sections.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  const earliest = (s: Section) => s.rows.reduce((a, b) => (ORDER.fieldGuide(b, a) < 0 ? b : a));
  const other = (s: Section) => Number(s.key === "f:familyGroups.other");
  return sections.sort((a, b) => other(a) - other(b) || ORDER.fieldGuide(earliest(a), earliest(b)));
}

/** A list item holding species: a row of cards or one row. */
export type SpeciesItem = { rows: CollectionSpecies[] } | { row: CollectionSpecies } | object;

/** The first visible species of a list. */
export const firstSpecies = (item: SpeciesItem | undefined): string | null =>
  item && "rows" in item
    ? (item.rows[0]?.scientificName ?? null)
    : item && "row" in item
      ? item.row.scientificName
      : null;

/** The index of the item holding a species, so the list keeps it in view when the columns change (-1 if gone). */
export const indexOfSpecies = (items: SpeciesItem[], name: string | null): number =>
  name === null
    ? -1
    : items.findIndex((it) =>
        "rows" in it ? it.rows.some((r) => r.scientificName === name) : "row" in it && it.row.scientificName === name,
      );
