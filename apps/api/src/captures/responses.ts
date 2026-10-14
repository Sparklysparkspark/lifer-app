// Response schemas for the capture routes. They document the answer in the OpenAPI document and
// type the web app's calls; fields not listed still pass through.
import { Type } from "typebox";
import { DateTime, NumberLike, Nullable, Open, Uuid } from "../lib/schema.js";
import { SpeciesSuggestion } from "../uploads/responses.js";

/** Suggestions are optional, so a failed match still answers 200, with `code` saying why. */
export const PhotoSuggestions = Open({
  suggestions: Type.Array(SpeciesSuggestion),
  code: Type.Optional(Type.String()),
});

export const VideoSuggestions = Open({
  suggestions: Type.Array(SpeciesSuggestion),
  error: Type.Optional(Type.String({ description: "Why there are no suggestions, when the video couldn't be read" })),
  code: Type.Optional(Type.String()),
  stagedId: Type.Optional(Nullable(Type.String({ description: "The kept copy, for importing without resending" }))),
  uploadId: Type.Optional(Nullable(Type.String())),
});

export const TrashList = Open({
  retentionDays: Type.Integer(),
  items: Type.Array(
    Open({
      captureId: Uuid(),
      speciesId: Uuid(),
      speciesName: Type.String(),
      deletedAt: DateTime(),
      pendingDeleteRaw: Nullable(Type.Boolean()),
      photoId: Nullable(Uuid()),
      width: Nullable(Type.Integer()),
      height: Nullable(Type.Integer()),
      hasRawOriginal: Type.Boolean(),
      kind: Type.Enum(["image", "video"]),
      durationSeconds: Nullable(NumberLike()),
      originalKind: Nullable(Type.String()),
      purgesAt: DateTime(),
    }),
  ),
});
