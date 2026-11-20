// Response schemas for the species page's routes (detail.ts, referencePhotos.ts, splitRoutes.ts).
// They document the answer in the OpenAPI document; fields not listed still pass through.
import { Type } from "typebox";
import { DateTime, Nullable, NullableNumbers, NumberLike, Ok, Open, Uuid } from "../lib/schema.js";

const Count = Type.Integer();

const Text = Nullable(Type.String());
// Postgres hands `numeric` columns over as text, sent as it came.
const Numeric = Nullable(Type.String());
const NullableNumberLike = Nullable(NumberLike());

// species.habitat_notes / identification_notes / summary_notes (migrations 140, 143).
const SpeciesNotes = Type.Optional(
  Nullable(
    Open({
      sections: Type.Array(Open({ heading: Type.String(), bullets: Type.Array(Type.String()) })),
      credit: Type.Optional(Text),
      source_url: Text,
      revision_id: Nullable(Type.Number()),
    }),
  ),
);

// The page's own payload mirrors database rows (snake_case) and is wide, so the fields the web
// app reads are listed and the rest pass through.
export const SpeciesDetail = Open({
  species: Open({
    id: Uuid(),
    scientific_name: Type.String(),
    common_name: Text,
    inat_taxon_id: Nullable(Type.Integer()),
    ebird_code: Text,
    aba_code: Text,
    taxon_class: Text,
    mass_g: Numeric,
    wingspan_mm: Numeric,
    trophic_niche: Text,
    primary_lifestyle: Text,
    nocturnal: Nullable(Type.Boolean()),
    home_range_km2: Numeric,
    depth_min_m: Numeric,
    depth_max_m: Numeric,
    domestic: Nullable(Type.Boolean()),
    iucn_status: Text,
    iucn_note: Text,
    tier: Text,
    is_other_taxa: Type.Boolean(),
    family: Text,
    taxon_order: Text,
    genus: Text,
    reference_photo: Text,
    reference_photo_url: Text,
    reference_credit: Text,
    reference_focal_x: NullableNumberLike,
    reference_focal_y: NullableNumberLike,
    description: Text,
    description_credit: Text,
    description_source_url: Text,
    habitat_description: Text,
    identification_notes: SpeciesNotes,
    habitat_notes: SpeciesNotes,
    summary_notes: SpeciesNotes,
  }),
  // Images are fetched by photo_id; cached derivative and reference image paths are never included.
  captures: Type.Array(
    Open({
      id: Uuid(),
      photo_id: Nullable(Uuid()),
      width: Nullable(Type.Integer()),
      height: Nullable(Type.Integer()),
      taken_at: Nullable(DateTime()),
      camera_model: Text,
      lens: Text,
      focal_length_mm: Numeric,
      aperture: Numeric,
      shutter: Text,
      iso: Nullable(Type.Integer()),
      quality_rating: Nullable(Type.Integer()),
      tags: Type.Array(Type.String()),
      photo_kind: Nullable(Type.Enum(["image", "video", "audio"])),
      duration_seconds: Nullable(Type.Number()),
      original_ref: Text,
      inat_observation_id: Text,
      original_managed: Nullable(Type.Boolean()),
      original_kind: Text,
      original_available: Nullable(Type.Boolean()),
      original_volume_label: Text,
      has_raw_original: Type.Boolean(),
      raw_ref: Text,
      region_id: Nullable(Uuid()),
      region_name: Text,
      trip_id: Nullable(Uuid()),
      location_label: Text,
      lat: Nullable(NumberLike()),
      lon: Nullable(NumberLike()),
    }),
  ),
  userSpecies: Nullable(
    Open({
      state: Nullable(Type.Enum(["collected", "seen"])),
      is_target: Type.Boolean(),
      needs_better_photo: Type.Optional(Type.Boolean()),
      cover_photo_id: Nullable(Uuid()),
      card_crop_x: NullableNumberLike,
      card_crop_y: NullableNumberLike,
      card_crop_size: NullableNumberLike,
      best_quality: Nullable(Type.Integer()),
    }),
  ),
  referencePhotos: Type.Array(
    Open({
      id: Uuid(),
      photo_url: Type.String(),
      credit: Type.String(),
      license: Type.String(),
      focal_x: NullableNumberLike,
      focal_y: NullableNumberLike,
      is_main: Type.Boolean(),
    }),
  ),
  seasonality: NullableNumbers(),
  weeklyFrequency: NullableNumbers(),
  weeklyRegionName: Text,
  localTier: Text,
  isVagrant: Type.Boolean(),
  isInvasive: Type.Boolean(),
  endemicCountryName: Text,
  isArchived: Type.Boolean(),
  regionBoundaryGeoJson: Type.Unknown(),
  hotspotDistribution: Nullable(Type.Enum(["widespread", "clustered"], { description: "null without hotspots" })),
  hotspots: Type.Array(
    Open({
      centroidLat: Type.Number(),
      centroidLon: Type.Number(),
      pointCount: Count,
      bboxDiagonalKm: Type.Number(),
      isSensitive: Type.Boolean(),
      lastSeenYear: Nullable(Count),
      distinctYears: Nullable(Count),
      recordShare: Type.Number(),
      isReliable: Type.Boolean(),
    }),
  ),
});

export const UnmatchedRaws = Open({
  rawFiles: Type.Array(
    Open({
      id: Uuid(),
      filename: Type.String(),
      fileSize: Type.Number(),
      addedAt: Type.String({ format: "date-time" }),
      previewUrl: Type.String(),
      downloadUrl: Type.String(),
    }),
  ),
});

const NamedCount = Type.Array(Open({ name: Type.String(), count: Count }), {
  description: "Most used first, capped; the matching count says how many there are in all",
});

export const SpeciesEncounters = Open({
  totalPhotos: Count,
  videoCount: Count,
  /** Recordings of this species; with no photos or videos it counts as heard. */
  audioCount: Count,
  encounterCount: Count,
  locationCount: Count,
  cameraCount: Count,
  lensCount: Count,
  locations: NamedCount,
  cameras: NamedCount,
  lenses: NamedCount,
  firstPhotographedAt: Nullable(DateTime({ description: "Earliest capture time, or null" })),
  lastPhotographedAt: Nullable(DateTime({ description: "Latest capture time, or null" })),
});

export const SpeciesSequences = Open({
  sequences: Type.Array(Open({ photoIds: Type.Array(Uuid()), bestPhotoId: Uuid(), count: Count })),
});

export const SpeciesVolumeUsage = Open({
  volumes: Type.Array(Open({ volumeId: Nullable(Uuid()), label: Nullable(Type.String()), count: Count })),
});

export const SpeciesReferencePhotos = Open({
  photos: Type.Array(Open({ url: Type.String(), credit: Nullable(Type.String()) })),
});

export const SplitApplied = Open({ ...Ok.properties, updated: Count });
