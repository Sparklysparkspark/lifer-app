// Response schemas for the pack list and download routes. They document the answer in the OpenAPI
// document and type the web app's calls; fields not listed still pass through.
import { Type } from "typebox";
import { Nullable, Open } from "../lib/schema.js";
import { PackIndexEntrySchema } from "./schemas.js";

// A pack as the index lists it (the shape this server downloads, schemas.ts), without its large
// species list, plus what's installed here.
const { scientificNames: _scientificNames, ...indexEntryFields } = PackIndexEntrySchema.properties;
export const PackStatusEntry = Open({
  ...indexEntryFields,
  downloaded: Type.Boolean(),
  updateAvailable: Type.Boolean(),
  photoBytes: Type.Optional(Type.Number({ description: "When the index lists it" })),
  checklistBytes: Type.Optional(Type.Number({ description: "When the index lists it" })),
});

export const PackList = Open({
  generatedAt: Type.String(),
  sizesPending: Type.Optional(
    Type.Boolean({ description: "Photo sizes aren't in sizeBytes yet: ask again shortly for them" }),
  ),
  packs: Type.Array(PackStatusEntry),
});

export const PackUpdatesSummary = Open({
  updateCount: Type.Integer(),
  totalBytes: Type.Number(),
  packIds: Type.Array(Type.String()),
});

export const PackRecommendation = Open({
  recommended: Type.Array(
    Open({
      id: Type.String(),
      region: Type.Optional(Type.String()),
      seaZone: Type.Optional(Type.String()),
      taxon: Nullable(Type.String()),
      sizeBytes: Type.Number(),
      covers: Type.Integer({ description: "How many of the requested species it adds" }),
    }),
  ),
  uncovered: Type.Array(Type.String()),
});

export const JobStatus = Open({ running: Type.Boolean() });
export const Started = Open({ started: Type.Boolean() });
export const Cancelled = Open({ cancelled: Type.Boolean() });
export const BatchStarted = Open({ started: Type.Boolean(), packIds: Type.Array(Type.String()) });

/** What deleting packs would remove and keep (a dry run). */
export const DeleteImpact = Open({
  checklistRegionsAffectedCount: Type.Integer(),
  speciesToRemoveCount: Type.Integer(),
  speciesKeptCount: Type.Integer(),
  bytesToFree: Type.Number(),
  isEstimate: Type.Boolean(),
});

export const PackDeleted = Open({
  deletedSpeciesFiles: Type.Integer(),
  keptSpeciesCount: Type.Integer(),
  regions: Type.Array(Type.String()),
});

export const PackProvinces = Open({
  provinces: Type.Array(Open({ id: Type.String(), name: Type.String(), applied: Type.Boolean() })),
  subdivisionLabel: Type.String({ description: 'What the country calls them, like "States"' }),
});
