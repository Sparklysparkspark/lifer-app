// GET /api/species/:id/encounters: photos vs encounters vs locations summary.
export interface EncountersResponse {
  totalPhotos: number;
  videoCount: number;
  encounterCount: number;
  locationCount: number;
  cameraCount: number;
  lensCount: number;
  firstPhotographedAt: string | null;
  lastPhotographedAt: string | null;
}

// GET /api/species/:id/unmatched-raws: RAWs filed under this species with no capture.
export interface UnmatchedRaw {
  id: string;
  filename: string | null;
  fileSize: number;
  addedAt: string;
  previewUrl: string;
  downloadUrl: string;
}

// GET /api/species/:id returns snake_case SQL rows.
export interface SpeciesDetail {
  species: {
    id: string;
    scientific_name: string;
    common_name: string | null;
    inat_taxon_id: number | null;
    ebird_code: string | null;
    taxon_class: string | null;
    mass_g: string | null;
    wingspan_mm: string | null;
    trophic_niche: string | null;
    primary_lifestyle: string | null;
    nocturnal: boolean | null;
    home_range_km2: string | null;
    depth_min_m: string | null;
    depth_max_m: string | null;
    domestic: boolean | null;
    iucn_status: string | null;
    tier: string | null;
    is_other_taxa: boolean;
    // Other Taxa have no trait dataset, so family/order/genus fill their stats box instead.
    family: string | null;
    taxon_order: string | null;
    genus: string | null;
    reference_photo: string | null;
    // Prefers the cached local copy; always render this, not reference_photo.
    reference_photo_url: string | null;
    reference_credit: string | null;
    reference_focal_x: number | string | null;
    reference_focal_y: number | string | null;
    description: string | null;
    description_credit: string | null;
    description_source_url: string | null;
    habitat_description: string | null;
  };
  captures: SpeciesCapture[];
  userSpecies: {
    state: "collected" | "seen" | null;
    is_target: boolean;
    cover_photo_id: string | null;
    card_crop_x: string | number | null;
    card_crop_y: string | number | null;
    card_crop_size: string | number | null;
    best_quality: number | null;
  } | null;
  referencePhotos: Array<{
    photo_url: string;
    credit: string;
    license: string;
    focal_x: number | string | null;
    focal_y: number | string | null;
  }>;
  seasonality: number[] | null;
  weeklyFrequency: number[] | null;
  weeklyRegionName: string | null;
  localTier: string | null;
  isVagrant: boolean;
  isInvasive: boolean;
  endemicCountryName: string | null;
  isArchived: boolean;
  regionBoundaryGeoJson: unknown;
  hotspotDistribution: "widespread" | "clustered" | null;
  hotspots: Array<{
    centroidLat: number;
    centroidLon: number;
    pointCount: number;
    bboxDiagonalKm: number;
    lastSeenYear: number | null;
    distinctYears: number | null;
    recordShare: number;
    isReliable: boolean;
    isSensitive: boolean;
  }>;
}

export interface SpeciesCapture {
  id: string;
  photo_id: string | null;
  width: number | null;
  height: number | null;
  taken_at: string | null;
  camera_model: string | null;
  lens: string | null;
  focal_length_mm: string | null;
  aperture: string | null;
  shutter: string | null;
  iso: number | null;
  quality_rating: number | null;
  tags: string[];
  photo_kind: "image" | "video" | null;
  duration_seconds: number | null;
  original_ref: string | null;
  original_managed: boolean | null;
  original_kind: string | null;
  original_available: boolean | null;
  // The disconnected external drive holding this original; null when the file is simply missing.
  original_volume_label: string | null;
  has_raw_original: boolean;
  raw_ref: string | null;
  region_id: string | null;
  region_name: string | null;
  // Free-text place name nested under region_id ("Prince George" under British Columbia).
  location_label: string | null;
}

export type PhotoFilter = "all" | "edited" | "raw" | "video";

export function filterBucketFor(c: SpeciesCapture): Exclude<PhotoFilter, "all"> {
  if (c.photo_kind === "video") return "video";
  return c.original_kind === "raw" ? "raw" : "edited";
}

// Full-resolution JPEG original when it's reachable, otherwise the display WebP (browsers can't
// render RAW, and an unavailable original would 404).
export function fullSizeUrl(capture: Pick<SpeciesCapture, "photo_id" | "original_ref" | "original_kind" | "original_available">) {
  if (!capture.photo_id) return null;
  if (capture.original_ref && capture.original_kind === "jpeg" && capture.original_available !== false) {
    return `/api/photos/${capture.photo_id}/original`;
  }
  return `/api/photos/${capture.photo_id}/display`;
}
