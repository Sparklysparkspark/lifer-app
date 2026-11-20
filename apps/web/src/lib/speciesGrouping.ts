import { compareFieldGuideOrder } from "@lifer/shared";
import { primaryBroadGroup, type BroadGroupSource } from "./broadGroups";
import { speciesGroupLabel, TIER_ORDER } from "./speciesGroups";

/** The Group choices the Collection and the Gallery share. */
export type SpeciesGroupBy = "broad" | "group" | "tier" | "localTier";

export interface GroupableSpecies extends BroadGroupSource {
  inatIconicTaxon?: string | null;
  tier?: string | null;
  localTier?: string | null;
}

/** The one group a species goes in: its first broad group, its family group or its tier. */
export function speciesGroupKey(item: GroupableSpecies, groupBy: SpeciesGroupBy, namingStyles?: string[]): string {
  if (groupBy === "tier") return item.tier ?? "common";
  // "Rarity here" falls back to the global tier when there's no local one.
  if (groupBy === "localTier") return item.localTier ?? item.tier ?? "common";
  // Other Taxa have no broad groups of their own; their iNat group (Insects, Fungi) is broad enough.
  if (groupBy === "broad" && !item.isOtherTaxa) return primaryBroadGroup(item);
  return speciesGroupLabel(item.taxonClass, item.family, item.isOtherTaxa, item.inatIconicTaxon, namingStyles);
}

const tierRank = (tier: string) => {
  const i = TIER_ORDER.indexOf(tier);
  return i < 0 ? TIER_ORDER.length - 1 : i;
};

/** Group keys in display order: tiers rarest first; other groups in field-guide order, each where
 *  its earliest species would come (Ducks before Grouse before Grebes), with leftovers ("Other
 *  Birds") after the named ones. `members` gives a group's species. Sorts in place. */
export function orderGroupKeys(
  keys: string[],
  groupBy: SpeciesGroupBy,
  members: (key: string) => GroupableSpecies[],
): string[] {
  if (groupBy === "tier" || groupBy === "localTier") return keys.sort((a, b) => tierRank(a) - tierRank(b));
  const earliest = new Map(
    keys.map((key) => [key, members(key).reduce((a, b) => (compareFieldGuideOrder(b, a) < 0 ? b : a))]),
  );
  return keys.sort(
    (a, b) =>
      Number(a.startsWith("Other ")) - Number(b.startsWith("Other ")) ||
      compareFieldGuideOrder(earliest.get(a)!, earliest.get(b)!) ||
      a.localeCompare(b),
  );
}
