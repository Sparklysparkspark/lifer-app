import type { ApiResponse } from "../../api/client";
import type { EditedRawFilter, MediaFilter, PhotoSort, RawFilesFilter } from "../../lib/photoListFilters";

// One photo in GET /api/gallery and /api/gallery/search, from the API's response schema.
export type GalleryItem = ApiResponse<"/gallery">["items"][number];
export type SearchResponse = ApiResponse<"/gallery/search">;
// How the server read a search query.
export type SearchInterpretation = NonNullable<SearchResponse["interpretation"]>;
// total only comes with the first page.
export type GalleryPageResponse = ApiResponse<"/gallery">;
export type ContextAnchor = { photoId: string; x: number; y: number };

// Everything that decides which photos the Gallery asks the server for.
export interface GalleryQuery {
  searchQuery: string;
  /** Only the photos imported hidden because a culling app rejected them. */
  onlyHidden: boolean;
  onlyTopRated: boolean;
  onlyFeatured: boolean;
  missingDate: boolean;
  /** One kind of shot (portrait, flight...), from Stats' Photography DNA. */
  shotKind: string | null;
  /** One rarity tier, from Stats' By tier list. */
  tier: string | null;
  /** With `tier`: the region whose local tier counts. */
  tierRegionId: string | null;
  selectedTaxa: Set<string>;
  rawFiles: RawFilesFilter;
  editedRaw: EditedRawFilter;
  mediaFilter: MediaFilter;
  dateFrom: string;
  dateTo: string;
  regionId: string | null;
  tag: string | null;
  scopeTripId: string | null;
  scopeAlbumId: string | null;
  sortBy: PhotoSort;
}
