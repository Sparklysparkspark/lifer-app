// Response schemas for the upload routes, and the species suggestion shape the trip and capture
// routes share. They document the answer in the OpenAPI document and type the web app's calls;
// fields not listed still pass through.
import { Type } from "typebox";
import { CULL_LABELS } from "@lifer/shared";
import { DateTime, Nullable, Open, Uuid } from "../lib/schema.js";

/** One species suggestion (SpeciesSuggestion in @lifer/core species/suggest.ts). */
export const SpeciesSuggestion = Open({
  id: Uuid(),
  scientific_name: Type.String(),
  common_name: Nullable(Type.String()),
  score: Type.Number(),
  source: Type.String({ description: "your_photos, reference_photo or keyword_tag" }),
  confident: Type.Optional(Type.Boolean()),
  matchPercent: Type.Optional(Type.Number()),
});

/** What a culling app marked a photo with (CullMarks in @lifer/shared). */
export const CullMarks = Open({
  verdict: Nullable(Type.Enum(["pick", "reject"])),
  label: Nullable(Type.Enum([...CULL_LABELS])),
});

/** A photo with nothing wild in it, and what it looks like instead. */
export const NotWildlife = Nullable(Open({ looksLike: Type.String() }));

/** An insect, spider or the like, which regional checklists rarely cover, e.g. "a bee". */
export const Invertebrate = Nullable(Open({ looksLike: Type.String() }));

export const UploadInspection = Open({
  takenAt: Nullable(DateTime()),
  keywords: Type.Array(Type.String()),
  cull: CullMarks,
  possibleDuplicate: Nullable(
    Open({
      captureId: Uuid(),
      photoId: Nullable(Uuid()),
      speciesId: Uuid(),
      speciesName: Type.String(),
      scientificName: Type.String(),
      commonName: Nullable(Type.String()),
      takenAt: Nullable(DateTime()),
      exact: Type.Boolean(),
    }),
  ),
  suggestions: Type.Array(SpeciesSuggestion),
  burst: Nullable(Open({ uploadIds: Type.Array(Type.String()), suggestions: Type.Array(SpeciesSuggestion) })),
  matchingMs: Nullable(Type.Number()),
  previewDataUrl: Nullable(Type.String()),
  stagedId: Nullable(Type.String()),
  uploadId: Nullable(Type.String()),
  notWildlife: NotWildlife,
  invertebrate: Invertebrate,
  /** A RAW whose JPEG is already imported: the import files it with that photo, under its species. */
  rawMatch: Nullable(
    Open({
      captureId: Uuid(),
      speciesId: Uuid(),
      speciesName: Type.String(),
      scientificName: Type.String(),
      commonName: Nullable(Type.String()),
    }),
  ),
});

/** POST /uploads: 201 with the new photo, or 200 for a duplicate or a skipped reject. */
export const UploadResponses = {
  200: Open({
    captureId: Type.Optional(Uuid()),
    photoId: Type.Optional(Nullable(Uuid())),
    duplicate: Type.Optional(Type.Boolean()),
    skipped: Type.Optional(Type.Literal("rejected")),
  }),
  201: Open({
    captureId: Uuid(),
    photoId: Nullable(Uuid({ description: "Null when a RAW was linked to a photo you already had" })),
    hidden: Type.Boolean(),
    linkedExisting: Type.Optional(Type.Boolean()),
  }),
};
