// Response schemas for the trip routes. They document the answer in the OpenAPI document and type
// the web app's calls; fields not listed still pass through.
import { Type } from "typebox";
import { DateTime, NumberLike, Nullable, Open, Uuid, jobStatusFields } from "../lib/schema.js";
import { CollectionItems } from "../collection/responses.js";
import { CullMarks, Invertebrate, NotWildlife, SpeciesSuggestion } from "../uploads/responses.js";

const Percent = Nullable(Type.Number());
const CoverLayout = Type.Enum(["single", "quad"]);

// TripSummary in @lifer/shared trip.ts.
export const TripList = Open({
  trips: Type.Array(
    Open({
      id: Uuid(),
      name: Type.String(),
      sourceFolder: Type.String(),
      destinationFolder: Type.String(),
      speciesCount: Type.Integer(),
      captureCount: Type.Integer(),
      earliestTakenAt: Nullable(DateTime()),
      latestTakenAt: Nullable(DateTime()),
      coverPhotoUrl: Nullable(Type.String()),
      coverCropX: Percent,
      coverCropY: Percent,
      coverCropSize: Percent,
      coverLayout: CoverLayout,
      quadPhotoIds: Type.Array(Uuid(), { description: "Up to 4 recent photos, for a quad cover" }),
      processing: Type.Boolean({ description: "A scan or import is running" }),
    }),
  ),
});

export const TripDetail = Open({
  id: Uuid(),
  name: Type.String(),
  description: Nullable(Type.String()),
  sourceFolder: Type.String(),
  destinationFolder: Type.String(),
  coverCaptureId: Nullable(Uuid()),
  coverCropX: Percent,
  coverCropY: Percent,
  coverCropSize: Percent,
  coverLayout: CoverLayout,
});

export const TripSpecies = CollectionItems;

export const TripSummary = Open({
  speciesCount: Type.Integer(),
  liferCount: Type.Integer(),
  rareCount: Type.Integer(),
  endemicCount: Type.Integer(),
});

export const TripPhotos = Open({
  items: Type.Array(
    Open({
      photoId: Uuid(),
      width: Nullable(Type.Integer()),
      height: Nullable(Type.Integer()),
      captureId: Uuid(),
      speciesId: Uuid(),
      scientificName: Type.String(),
      commonName: Nullable(Type.String()),
      takenAt: Nullable(DateTime()),
      hasRaw: Type.Boolean(),
      originalRef: Nullable(Type.String()),
      originalKind: Nullable(Type.String()),
      cameraModel: Nullable(Type.String()),
      lens: Nullable(Type.String()),
      focalLengthMm: Nullable(NumberLike()),
      aperture: Nullable(NumberLike()),
      shutter: Nullable(Type.String()),
      iso: Nullable(Type.Integer()),
      qualityRating: Nullable(Type.Integer()),
    }),
  ),
});

const ScanSummaryFields = {
  relinked: Type.Integer(),
  markedStale: Type.Integer(),
  collisions: Type.Integer(),
  recovered: Type.Integer(),
  rawsLinked: Type.Integer(),
  newFiles: Type.Array(Open({ relativePath: Type.String(), cull: CullMarks })),
  cullRejected: Type.Integer(),
  cullPicked: Type.Integer(),
};

// The summary is mirrored top-level, alongside `result`, while the scan runs.
export const TripScanStatus = Open({
  ...jobStatusFields(Open(ScanSummaryFields)),
  tripId: Uuid(),
  ...ScanSummaryFields,
});

export const TripImportStatus = Open({
  ...jobStatusFields(
    Open({ imported: Type.Integer(), failed: Type.Integer(), skipped: Type.Integer(), hidden: Type.Integer() }),
  ),
  tripId: Uuid(),
  results: Type.Array(
    Open({
      relativePath: Type.String(),
      captureId: Type.Optional(Uuid()),
      error: Type.Optional(Type.String()),
      skipped: Type.Optional(Type.Literal("rejected")),
      hidden: Type.Optional(Type.Boolean()),
    }),
    { description: "Grows as files finish" },
  ),
});

export const TripInspection = Open({
  suggestions: Type.Array(SpeciesSuggestion),
  notWildlife: NotWildlife,
  invertebrate: Invertebrate,
  takenAt: Nullable(DateTime()),
});
