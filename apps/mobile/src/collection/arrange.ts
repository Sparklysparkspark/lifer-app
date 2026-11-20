// Pure rules for the Collection: filter, order and group the species rows. No React, so it is unit tested.
import { TIER_ORDER } from "@lifer/shared";
import { GROUP_ORDER, groupOf, type GroupId } from "../theme/groups";
import type { CollectionSpecies } from "../store/browse";
import type { Arrange, CollectionView } from "./model";

const STATUS_RANK = { photographed: 0, seen: 1, none: 2 } as const;
// Species with no tier sort after every tiered one.
const tierRank = (t: string | null) => TIER_ORDER.indexOf(t as never);
const name = (r: CollectionSpecies) => r.commonName ?? r.scientificName;
const byName = (a: CollectionSpecies, b: CollectionSpecies) => name(a).localeCompare(name(b), undefined, { sensitivity: "base" });

const ORDER: Record<Arrange, (a: CollectionSpecies, b: CollectionSpecies) => number> = {
  common: byName,
  scientific: (a, b) => a.scientificName.localeCompare(b.scientificName, undefined, { sensitivity: "base" }),
  // Rarest first: the species hardest to find lead.
  rarity: (a, b) => tierRank(b.tier) - tierRank(a.tier) || byName(a, b),
  photographedFirst: (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || byName(a, b),
  seenFirst: (a, b) => Number(b.status === "seen") - Number(a.status === "seen") || STATUS_RANK[a.status] - STATUS_RANK[b.status] || byName(a, b),
  targetsFirst: (a, b) => Number(b.isTarget) - Number(a.isTarget) || byName(a, b),
};

/** The Show choice, the rarity and vagrant filters and the year, applied to a region's species. */
export function filterSpecies(rows: CollectionSpecies[], v: CollectionView, inYear: Set<string> | null): CollectionSpecies[] {
  return rows.filter((r) => {
    if (v.show === "photographed" && r.status !== "photographed") return false;
    if (v.show === "seen" && r.status !== "seen") return false;
    if (v.show === "targets" && !r.isTarget) return false;
    if (v.show === "unseen" && r.status !== "none") return false;
    if (v.tiers.length && !(r.tier && v.tiers.includes(r.tier))) return false;
    if (!v.vagrants && r.vagrant) return false;
    if (v.year && !inYear?.has(r.scientificName)) return false;
    return true;
  });
}

export const sortSpecies = (rows: CollectionSpecies[], arrange: Arrange): CollectionSpecies[] => [...rows].sort(ORDER[arrange]);

export interface Section {
  group: GroupId;
  rows: CollectionSpecies[];
  /** Species of this group that are photographed, out of all the group's species in the region. */
  photographed: number;
  total: number;
}

/** Rows split into the broad groups, in the fixed group order; empty groups are left out. */
export function groupSpecies(rows: CollectionSpecies[], all: CollectionSpecies[]): Section[] {
  const totals = new Map<GroupId, { photographed: number; total: number }>();
  for (const r of all) {
    const t = totals.get(groupOf(r.taxonClass).id) ?? { photographed: 0, total: 0 };
    t.total++;
    if (r.status === "photographed") t.photographed++;
    totals.set(groupOf(r.taxonClass).id, t);
  }
  const by = new Map<GroupId, CollectionSpecies[]>();
  for (const r of rows) {
    const g = groupOf(r.taxonClass).id;
    by.set(g, [...(by.get(g) ?? []), r]);
  }
  return GROUP_ORDER.filter((g) => by.has(g)).map((g) => ({ group: g, rows: by.get(g)!, ...totals.get(g)! }));
}
