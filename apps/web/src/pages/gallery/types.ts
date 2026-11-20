import type { ApiResponse } from "../../api/client";
import type { EditedRawFilter, MediaFilter, PhotoSort, RawFilesFilter } from "../../lib/photoListFilters";

// One photo in GET /api/gallery and /api/gallery/search, from the API's response schema.
export type GalleryItem = ApiResponse<"/gallery">["items"][number];
export type SearchResponse = ApiResponse<"/gallery/search">;
// How the server read a search query.
export type SearchInterpretation = NonNullable<SearchResponse["interpretation"]>;
// total only comes with the first page.
export type GalleryPageResponse = ApiResponse<"/gallery">;

// Everything that decides which photos the Gallery asks the server for.
export interface GalleryQuery {
  searchQuery: string;
  /** Only the photos imported hidden because a culling app rejected them. */
  onlyHidden: boolean;
  /** Star rating range, both ends inclusive; unrated photos never match a range. */
  ratingMin: number | null;
  ratingMax: number | null;
  /** Only photos with no star rating; never set with a range. */
  unrated: boolean;
  /** How many animals the detector found, both ends inclusive ("exactly 3" sets both). */
  animalsMin: number | null;
  animalsMax: number | null;
  onlyFeatured: boolean;
  /** Only photos not yet sent to iNaturalist. */
  notOnInat: boolean;
  missingDate: boolean;
  /** Only photos with no map pin (no coordinates). */
  missingCoordinates: boolean;
  /** Shot type, as Stats' Photography DNA reads it: any of these actions, and any of these
   *  framings (an empty set is any). */
  shotActions: ReadonlySet<string>;
  shotFramings: ReadonlySet<string>;
  /** Rarity tiers, from Stats' By tier list: a photo matches any one of them. */
  tiers: readonly string[];
  /** With `tiers`: the region whose local tier counts. */
  tierRegionId: string | null;
  selectedTaxa: Set<string>;
  rawFiles: RawFilesFilter;
  editedRaw: EditedRawFilter;
  mediaFilter: MediaFilter;
  dateFrom: string;
  dateTo: string;
  /** Each of these takes several values: a photo matches any one of a filter's values. A region
   *  can be UNCATEGORIZED_REGION_ID, for photos with no region. */
  regionIds: readonly string[];
  tags: readonly string[];
  /** Exact place names, from Settings > Library > Places. */
  places: readonly string[];
  /** A map area, "west,south,east,north", from a point clicked on the map view. */
  bbox?: string | null;
  /** A photo whose near-identical group is shown on its own, every other filter set aside. */
  similarTo?: string | null;
  scopeTripId: string | null;
  scopeAlbumId: string | null;
  sortBy: PhotoSort;
}
