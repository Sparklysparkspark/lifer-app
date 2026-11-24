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
  probably: Type.Optional(
    Type.Object(
      {
        rank: Type.Enum(["genus", "family"]),
        name: Type.String({ description: "Scientific name of the genus or family" }),
        taxonClass: Nullable(Type.String({ description: "The top candidate's catalog class, e.g. amphibia" })),
      },
      {
        additionalProperties: true,
        description:
          "Only on a top suggestion that isn't confident: the genus (else family) most close candidates share, e.g. 'Probably a Lithobates frog'",
      },
    ),
  ),
});

/** What a culling app marked a photo with (CullMarks in @lifer/shared). */
export const CullMarks = Open({
  verdict: Nullable(Type.Enum(["pick", "reject"])),
  label: Nullable(Type.Enum([...CULL_LABELS])),
});

/** A photo with nothing wild in it, and what it looks like instead. */
export const NotWildlife = Nullable(Open({ looksLike: Type.String() }));

/** Probably not wildlife, short of a flag: the import asks instead of leaving it out. `share` (0 to 1)
 *  is how much of the photo's reading went to the scene. */
export const MaybeNotWildlife = Nullable(Open({ looksLike: Type.String(), share: Type.Number() }));

/** An insect, spider or the like, which regional checklists rarely cover, e.g. "a bee". */
export const Invertebrate = Nullable(Open({ looksLike: Type.String() }));

export const UploadInspection = Open({
  takenAt: Nullable(DateTime()),
  cameraTime: Nullable(
    Type.String({ description: "The camera's own clock, YYYY-MM-DDTHH:MM:SS with no time zone, for grouping" }),
  ),
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
  maybeNotWildlife: Type.Optional(MaybeNotWildlife),
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
  /** An edited copy of a RAW already imported (the same XMP document, or the same shutter press and
   *  name): the import links it to that photo as a version, under its species, and shows it. */
  editedVersionOf: Nullable(
    Open({
      captureId: Uuid(),
      photoId: Nullable(Uuid()),
      speciesId: Uuid(),
      speciesName: Type.String(),
      scientificName: Type.String(),
      commonName: Nullable(Type.String()),
      takenAt: Nullable(DateTime()),
    }),
  ),
  /** What links this file with another of the same batch as one photo (a RAW and its edit): the XMP
   *  document it descends from, and its shutter press (time, sub-second and body serial) as an
   *  opaque key. Null when the file doesn't record them. */
  versionEvidence: Type.Optional(
    Open({
      documentId: Nullable(Type.String()),
      press: Nullable(Type.String()),
    }),
  ),
  /** The animal's box in percent of the upright photo (the preview shown), when matching located it. */
  subject: Nullable(Open({ x: Type.Number(), y: Type.Number(), w: Type.Number(), h: Type.Number() })),
  /** The camera's GPS point, with the most specific region holding it and the nearest town. */
  gps: Nullable(
    Open({
      lat: Type.Number(),
      lon: Type.Number(),
      regionId: Nullable(Uuid()),
      town: Nullable(Type.String({ description: "The nearest town within 25 km, from the offline town list" })),
    }),
  ),
});

/** POST /uploads: 201 with the new photo, or 200 for a duplicate or a skipped reject. */
/** Why a file stayed where it was instead of going to the Trash (sourceTrash.ts). */
export const TrashReason = Type.Enum([
  "not_in_source_folder",
  "in_library",
  "unreadable",
  "no_library_copy",
  "partner_stays",
  "trash_failed",
]);

export const UploadResponses = {
  200: Open({
    captureId: Type.Optional(Uuid()),
    photoId: Type.Optional(Nullable(Uuid())),
    duplicate: Type.Optional(Type.Boolean()),
    skipped: Type.Optional(Type.Literal("rejected")),
    sha256: Type.Optional(Type.String({ description: "sha256 of the file you already have (duplicate)" })),
  }),
  201: Open({
    captureId: Uuid(),
    photoId: Nullable(Uuid({ description: "Null when a RAW was linked to a photo you already had" })),
    hidden: Type.Boolean(),
    linkedExisting: Type.Optional(Type.Boolean()),
    sha256: Type.String({ description: "sha256 (hex) of the stored file's bytes, to verify the upload" }),
    rawSha256: Type.Optional(Type.String({ description: "sha256 of the RAW sent with the photo, when one was" })),
    sourceMove: Type.Optional(
      Type.Object(
        {
          moved: Type.Boolean(),
          reason: Nullable(TrashReason),
          sidecars: Type.Integer({ description: "XMP sidecars that went to the Trash with it" }),
        },
        {
          additionalProperties: true,
          description: "Desktop, with moveSourcePath: whether the original went to the Trash, and why not",
        },
      ),
    ),
  }),
};
