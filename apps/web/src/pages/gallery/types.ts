import type { CullLabel, CullVerdict } from "@lifer/shared";
import type { MediaFilter, PhotoSort, RawFilter } from "../../lib/photoListFilters";

// One photo in GET /api/gallery and /api/gallery/search.
export interface GalleryItem {
  photoId: string;
  width: number | null;
  height: number | null;
  captureId: string;
  speciesId: string;
  scientificName: string;
  commonName: string | null;
  taxonClass: string;
  takenAt: string | null;
  cameraModel: string | null;
  lens: string | null;
  focalLengthMm: number | null;
  aperture: number | null;
  shutter: string | null;
  iso: number | null;
  qualityRating: number | null;
  /** What a culling app marked it at import, and whether it was imported hidden. */
  cullVerdict?: CullVerdict | null;
  cullLabel?: CullLabel | null;
  hidden?: boolean;
  lat: number | null;
  lon: number | null;
  regionId: string | null;
  regionName: string | null;
  kind: "image" | "video";
  durationSeconds: number | null;
  tags: string[];
  isFeatured: boolean;
  hasRawOriginal: boolean;
  originalRef: string | null;
  originalManaged: boolean | null;
  originalKind: string | null;
  rawRef: string | null;
}

// How the server read a search query.
export interface SearchInterpretation {
  species: string[];
  groups: string[];
  places: string[];
  dates: string[];
  description: string | null;
}

export type SearchResponse = { items: GalleryItem[]; interpretation?: SearchInterpretation; pending?: boolean };
// total only comes with the first page.
export type GalleryPageResponse = { items: GalleryItem[]; nextCursor: string | null; total?: number };
export type ContextAnchor = { photoId: string; x: number; y: number };

// Everything that decides which photos the Gallery asks the server for.
export interface GalleryQuery {
  searchQuery: string;
  /** Only the photos imported hidden because a culling app rejected them. */
  onlyHidden: boolean;
  onlyTopRated: boolean;
  onlyFeatured: boolean;
  missingDate: boolean;
  selectedTaxa: Set<string>;
  rawFilter: RawFilter;
  mediaFilter: MediaFilter;
  dateFrom: string;
  dateTo: string;
  regionId: string | null;
  tag: string | null;
  scopeTripId: string | null;
  scopeAlbumId: string | null;
  sortBy: PhotoSort;
}
