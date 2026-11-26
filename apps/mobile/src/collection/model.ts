import type { SpeciesFilter } from "../store/marks";
import type { GroupId } from "../theme/groups";

export type Show = SpeciesFilter;
export type Arrange =
  "fieldGuide" | "common" | "scientific" | "rarity" | "photographedFirst" | "seenFirst" | "targetsFirst";
export type GroupBy = "broad" | "family" | "none";
export type CardSize = "large" | "small" | "list";
/** A record filter as the desktop's: any, only these, or hide them. */
export type Trait = "any" | "only" | "hide";
/** Narrows photographed species by where their photos were taken. */
export type PhotosTaken = "anywhere" | "here" | "elsewhere";

export interface CollectionView {
  /** A kept region's key; null is Everywhere (the whole life list). */
  region: string | null;
  /** Regions chosen before, newest first, for the picker. */
  recent: string[];
  show: Show;
  arrange: Arrange;
  group: GroupBy;
  size: CardSize;
  /** Tiers to keep (with "unrated"), matched against the tier the card shows; empty keeps all. */
  tiers: string[];
  vagrant: Trait;
  photosTaken: PhotosTaken;
  needsBetter: boolean;
  year: string | null;
  /** Sections folded to their header, remembered like the rest of the view. */
  collapsed: string[];
  showRarityTags: boolean;
  showGroupProgress: boolean;
  uncollectedColour: boolean;
  hideNames: boolean;
}

export const DEFAULT_VIEW: CollectionView = {
  region: null,
  recent: [],
  show: "all",
  arrange: "photographedFirst",
  group: "broad",
  size: "large",
  tiers: [],
  vagrant: "any",
  photosTaken: "anywhere",
  needsBetter: false,
  year: null,
  collapsed: [],
  showRarityTags: true,
  showGroupProgress: true,
  uncollectedColour: false,
  hideNames: false,
};

export const CLEARED_FILTERS: Partial<CollectionView> = {
  show: "all",
  tiers: [],
  vagrant: "any",
  photosTaken: "anywhere",
  needsBetter: false,
  year: null,
};

/** A saved view from any version: the old vagrants switch becomes the three-way filter. */
export function loadView(saved: Partial<CollectionView> & { vagrants?: boolean }): CollectionView {
  const { vagrants, ...rest } = saved;
  return { ...DEFAULT_VIEW, ...(vagrants === false ? { vagrant: "hide" as const } : {}), ...rest };
}

export const activeFilterCount = (v: CollectionView): number =>
  (v.show !== "all" ? 1 : 0) +
  (v.tiers.length ? 1 : 0) +
  (v.vagrant !== "any" ? 1 : 0) +
  (v.photosTaken !== "anywhere" ? 1 : 0) +
  (v.needsBetter ? 1 : 0) +
  (v.year ? 1 : 0);

export interface GalleryView {
  columns: number;
  /** By date (month headings with the place) or one continuous grid. */
  layout: "date" | "continuous";
  aspect: boolean;
  featured: boolean;
  group: GroupId | null;
  trip: string | null;
  year: string | null;
}

export const DEFAULT_GALLERY: GalleryView = {
  columns: 3,
  layout: "date",
  aspect: false,
  featured: false,
  group: null,
  trip: null,
  year: null,
};

export const CLEARED_GALLERY: Partial<GalleryView> = { featured: false, group: null, trip: null, year: null };

export const galleryFilterCount = (v: GalleryView): number =>
  (v.featured ? 1 : 0) + (v.group ? 1 : 0) + (v.trip ? 1 : 0) + (v.year ? 1 : 0);
