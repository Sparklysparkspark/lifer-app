import type { SpeciesFilter } from "../store/marks";
import type { GroupId } from "../theme/groups";

export type Show = SpeciesFilter;
export type Arrange = "common" | "scientific" | "rarity" | "photographedFirst" | "seenFirst" | "targetsFirst";
export type GroupBy = "broad" | "none";
export type CardSize = "large" | "small" | "list";

export interface CollectionView {
  /** A kept region's key; null is Everywhere (the whole life list). */
  region: string | null;
  /** Regions chosen before, newest first, for the picker. */
  recent: string[];
  show: Show;
  arrange: Arrange;
  group: GroupBy;
  size: CardSize;
  tiers: string[];
  vagrants: boolean;
  year: string | null;
  /** Broad groups folded to their header, remembered like the rest of the view. */
  collapsed: GroupId[];
}

export const DEFAULT_VIEW: CollectionView = {
  region: null,
  recent: [],
  show: "all",
  arrange: "photographedFirst",
  group: "broad",
  size: "large",
  tiers: [],
  vagrants: true,
  year: null,
  collapsed: [],
};

export const activeFilterCount = (v: CollectionView): number =>
  (v.show !== "all" ? 1 : 0) + (v.tiers.length ? 1 : 0) + (v.vagrants ? 0 : 1) + (v.year ? 1 : 0);
