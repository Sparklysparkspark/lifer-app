// Response schemas for the userdata.read routes. Closed objects on purpose: the serializer drops any
// field not listed, so catalog data can't ride along (userdata.test.ts checks the field names).
import { Type } from "typebox";
import { CULL_LABELS } from "@lifer/shared";
import { DateTime, Nullable, Uuid } from "../lib/schema.js";

/** Field names that would mean catalog data, which these routes never return. */
export const CATALOG_FIELD = /region|checklist|tier|rarity|season|weekly|reference|description|commonName/i;

export const UserSpeciesItem = Type.Object({
  speciesId: Nullable(Uuid({ description: "This server's id; null on a deletion whose species is gone" })),
  scientificName: Type.String({ description: "Match species across installs and taxonomies by this" }),
  state: Nullable(Type.Enum(["photographed", "seen"], { description: "null when only a target, or unmarked" })),
  isTarget: Type.Boolean(),
  firstCollected: Nullable(DateTime()),
  lastPhotographed: Nullable(DateTime()),
  photoCount: Type.Integer(),
  bestRating: Nullable(Type.Integer({ description: "1-5" })),
  coverPhotoId: Nullable(Uuid({ description: "Fetch with GET /api/userdata/v1/photos/{id}/display" })),
  updatedAt: Type.String({ description: "Full-precision time of the last change" }),
  deletedAt: Nullable(Type.String({ description: "Set when the species mark was removed; drop the row" })),
});

export const UserSpeciesPage = Type.Object({
  items: Type.Array(UserSpeciesItem),
  nextCursor: Nullable(Type.String()),
});

const Rating = Nullable(Type.Integer({ description: "1-5" }));
const Flag = Nullable(Type.Enum(["pick", "reject"]));
const Label = Nullable(Type.Enum([...CULL_LABELS], { description: "Colour label" }));

export const FeaturedPhoto = Type.Object({
  photo: Nullable(
    Type.Object({
      photoId: Uuid({ description: "Fetch with GET /api/userdata/v1/photos/{id}/display" }),
      chosenByUser: Type.Boolean({ description: "The user or an app chose it, rather than Lifer" }),
      cardCrop: Nullable(
        Type.Object(
          { x: Type.Number(), y: Type.Number(), size: Type.Number() },
          { description: "Percent of the photo" },
        ),
      ),
      rating: Rating,
      flag: Flag,
      label: Label,
    }),
  ),
  needsBetterPhoto: Type.Boolean(),
});

export const SpeciesPhotos = Type.Object({
  items: Type.Array(
    Type.Object({
      photoId: Uuid(),
      captureId: Uuid(),
      thumbnailUrl: Type.String({ description: "Relative to the server; fetch with the same key" }),
      rating: Rating,
      flag: Flag,
      label: Label,
      takenAt: Nullable(DateTime()),
      featured: Type.Boolean({ description: "This is the species' featured photo" }),
    }),
  ),
});

export const SimilarPhotos = Type.Object({
  model: Type.String(),
  items: Type.Array(
    Type.Object({
      photoId: Uuid(),
      similarity: Type.Number({ description: "Cosine similarity, -1 to 1, higher is closer" }),
      rating: Rating,
      flag: Flag,
      label: Label,
      takenAt: Nullable(DateTime()),
      featured: Type.Boolean({ description: "This is the species' featured photo" }),
    }),
  ),
});
