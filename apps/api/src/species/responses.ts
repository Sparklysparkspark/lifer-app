// Response schemas for the species page's routes (detail.ts, referencePhotos.ts, splitRoutes.ts).
// They document the answer in the OpenAPI document; fields not listed still pass through.
import { Type } from "typebox";
import { Nullable, Ok, Open, Uuid } from "../lib/schema.js";

const Count = Type.Integer();

// The page's own payload mirrors database rows (snake_case) and is wide, so only its outline and
// the fields integrations are likely to read are listed.
export const SpeciesDetail = Open({
  species: Open({
    scientific_name: Type.String(),
    common_name: Nullable(Type.String()),
    taxon_class: Nullable(Type.String()),
    tier: Nullable(Type.String()),
    reference_photo_url: Nullable(Type.String()),
  }),
  // Images are fetched by photo_id; cached derivative and reference image paths are never included.
  captures: Type.Array(Open({ id: Uuid(), photo_id: Nullable(Uuid()), taken_at: Type.Unknown() })),
  userSpecies: Type.Unknown({ description: "The user's state for this species, or null" }),
  referencePhotos: Type.Array(
    Open({ id: Uuid(), photo_url: Type.String(), credit: Nullable(Type.String()), is_main: Type.Boolean() }),
  ),
  seasonality: Type.Unknown(),
  weeklyFrequency: Type.Unknown(),
  weeklyRegionName: Type.Unknown(),
  localTier: Type.Unknown(),
  isVagrant: Type.Unknown(),
  isInvasive: Type.Unknown(),
  endemicCountryName: Nullable(Type.String()),
  isArchived: Type.Boolean(),
  regionBoundaryGeoJson: Type.Unknown(),
  hotspotDistribution: Nullable(Type.String({ description: '"widespread" or "clustered", null without hotspots' })),
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

export const SpeciesEncounters = Open({
  totalPhotos: Count,
  videoCount: Count,
  encounterCount: Count,
  locationCount: Count,
  cameraCount: Count,
  lensCount: Count,
  firstPhotographedAt: Type.Unknown({ description: "Earliest capture time, or null" }),
  lastPhotographedAt: Type.Unknown({ description: "Latest capture time, or null" }),
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
