// Response schemas for the Gallery routes, and the photo shape albums and the command palette
// reuse. They document the answer in the OpenAPI document and type the web app's calls; fields not
// listed still pass through.
import { Type } from "typebox";
import { CULL_LABELS } from "@lifer/shared";
import { DateTime, NumberLike, Nullable, Open, Uuid } from "../lib/schema.js";

/** One photo (toGalleryItem in routes.ts). */
export const GalleryItem = Open({
  photoId: Uuid(),
  width: Nullable(Type.Integer()),
  height: Nullable(Type.Integer()),
  captureId: Uuid(),
  speciesId: Uuid(),
  scientificName: Type.String(),
  commonName: Nullable(Type.String()),
  taxonClass: Type.String(),
  takenAt: Nullable(DateTime()),
  cameraModel: Nullable(Type.String()),
  lens: Nullable(Type.String()),
  focalLengthMm: Nullable(NumberLike()),
  aperture: Nullable(NumberLike()),
  shutter: Nullable(Type.String()),
  iso: Nullable(Type.Integer()),
  qualityRating: Nullable(Type.Integer()),
  lat: Nullable(NumberLike()),
  lon: Nullable(NumberLike()),
  regionId: Nullable(Uuid()),
  regionName: Nullable(Type.String()),
  kind: Type.Enum(["image", "video"]),
  durationSeconds: Nullable(NumberLike()),
  tags: Type.Array(Type.String()),
  cullVerdict: Nullable(Type.Enum(["pick", "reject"])),
  cullLabel: Nullable(Type.Enum([...CULL_LABELS])),
  hidden: Type.Boolean({ description: "Imported hidden because a culling app rejected it" }),
  isFeatured: Nullable(Type.Boolean({ description: "Its species' cover photo (null when the species has none)" })),
  hasRawOriginal: Type.Boolean(),
  originalRef: Nullable(Type.String()),
  originalManaged: Nullable(Type.Boolean()),
  originalKind: Nullable(Type.String()),
  rawRef: Nullable(Type.String()),
  matchScore: Nullable(Type.Number({ description: "How well a search matched; null for the plain listing" })),
});

/** How the server read a search query. */
export const SearchInterpretation = Open({
  species: Type.Array(Type.String()),
  groups: Type.Array(Type.String()),
  scenes: Type.Array(Type.String({ description: 'Scene and colour words read from the photo ("water", "purple")' })),
  places: Type.Array(Type.String()),
  dates: Type.Array(Type.String()),
  description: Nullable(Type.String()),
});
