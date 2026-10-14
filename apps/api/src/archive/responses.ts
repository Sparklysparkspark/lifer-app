// Response schemas for the archive routes. They document the answer in the OpenAPI document and
// type the web app's calls; fields not listed still pass through.
import { Type } from "typebox";
import { DateTime, Nullable, Open, Uuid } from "../lib/schema.js";

export const ArchiveList = Open({
  items: Type.Array(
    Open({
      speciesId: Uuid(),
      scientificName: Type.String(),
      commonName: Nullable(Type.String()),
      taxonClass: Type.String(),
      family: Nullable(Type.String()),
      referencePhoto: Nullable(Type.String()),
      referenceThumbUrl: Nullable(Type.String()),
      archivedAt: DateTime(),
    }),
  ),
  families: Type.Array(Open({ taxonClass: Type.String(), family: Type.String(), count: Type.Integer() })),
});
