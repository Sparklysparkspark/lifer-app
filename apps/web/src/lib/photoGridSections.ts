// The sections and option labels the shared View and Filters menus offer (PhotoGridControls,
// PhotoFiltersMenu), so every page names the same choice the same way.
import type { PhotoSort } from "./photoListFilters";

// Each option's one label, so a choice reads the same in every View menu.
export const GROUP_LABEL_KEYS = {
  none: "collection.toolbar.groupNone",
  region: "gallery.toolbar.region",
  broad: "collection.toolbar.groupBroad",
  group: "collection.toolbar.groupFamily",
  tier: "collection.toolbar.rarity",
  localTier: "collection.toolbar.rarityHere",
  species: "collection.toolbar.groupSpecies",
} as const;
export type GroupOption = keyof typeof GROUP_LABEL_KEYS;

export const SORT_LABEL_KEYS = {
  newest: "photoFilters.sort.newest",
  oldest: "photoFilters.sort.oldest",
  ratingHigh: "photoFilters.sort.ratingHigh",
  // The species page's name for the same order.
  rating: "photoFilters.sort.ratingHigh",
  ratingLow: "photoFilters.sort.ratingLow",
  taxonomic: "collection.toolbar.sortTaxonomic",
  name: "collection.toolbar.sortName",
  scientific: "collection.toolbar.sortScientific",
  rarity: "collection.toolbar.rarity",
  localRarity: "collection.toolbar.rarityHere",
  count: "photoFilters.sort.count",
  // Albums and trips, which have a name rather than a species.
  title: "photoFilters.sort.title",
} as const;
export type SortOption = keyof typeof SORT_LABEL_KEYS;

/** The photo orders the Gallery, album and trip pages offer: by date and rating, then the
 *  Collection's species orders. */
export const PHOTO_SORTS: readonly PhotoSort[] = [
  "newest",
  "oldest",
  "ratingHigh",
  "ratingLow",
  "taxonomic",
  "name",
  "scientific",
  "rarity",
];

/** The View menu's sections, always shown in this order. */
export type ViewSection =
  | "show"
  | "layout"
  | "group"
  | "sort"
  | "size"
  | "captions"
  | "order"
  | "hideNames"
  | "mapPins"
  | "groupProgress"
  | "versions"
  | "bursts"
  | "counting"
  | "nameSettings";

/** The Filters menu's sections, always shown in this order. */
export type PhotoFilterSection =
  | "animals"
  // A page's own species list (a trip's); only pages that pass the choices show it.
  | "species"
  | "scope"
  | "showOnly"
  | "rating"
  | "animalCount"
  | "rarity"
  | "shotKind"
  | "appearance"
  | "region"
  | "place"
  | "tag"
  | "date"
  | "media"
  | "raw";

/** Every section, as the Gallery and the smart album builder show them. */
export const ALL_PHOTO_FILTER_SECTIONS: readonly PhotoFilterSection[] = [
  "animals",
  "scope",
  "showOnly",
  "rating",
  "animalCount",
  "rarity",
  "shotKind",
  "appearance",
  "region",
  "place",
  "tag",
  "date",
  "media",
  "raw",
];

/** The Gallery, album and trip grids: everything but the smart album builder's search scope. */
export const GRID_PHOTO_FILTER_SECTIONS = ALL_PHOTO_FILTER_SECTIONS.filter((s) => s !== "scope");
