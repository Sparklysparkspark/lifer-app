// Response schemas for the pack list and download routes. They document the answer in the OpenAPI
// document and type the web app's calls; fields not listed still pass through.
import { Type } from "typebox";
import { jobStatusFields, LoadProgress, Nullable, Open } from "../lib/schema.js";
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
  freeBytes: Nullable(Type.Number({ description: "Free space where packs are stored; null when unknown" })),
  indexUnavailable: Type.Optional(
    Type.Boolean({
      description:
        "No copy of the published index yet (none fetched, none saved): installed packs come from this computer and nothing else is offered",
    }),
  ),
  remote: Type.Optional(
    Type.Enum(["online", "slow", "offline"], {
      description:
        "The connection to the index host: slow after a timeout (downloads still work, just slower), offline only when it couldn't be reached at all",
    }),
  ),
  indexProgress: Type.Optional(
    Open({
      receivedBytes: Type.Number(),
      totalBytes: Nullable(Type.Number()),
    }),
  ),
  indexRefreshing: Type.Optional(Type.Boolean({ description: "A newer index is still on its way: ask again shortly" })),
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

// Matches @lifer/shared's PackDownloadStatus: downloading, setting up and photos run at once,
// and each lane counts packs.
const PackLane = {
  currentItem: Nullable(Type.String()),
  processed: Type.Integer(),
  total: Type.Integer(),
  downloadedBytes: Nullable(Type.Number()),
  totalBytes: Nullable(Type.Number()),
};
export const PackDownloadStatus = Open({
  ...jobStatusFields(Open({ packsApplied: Type.Integer() })),
  packIds: Type.Array(Type.String()),
  currentPack: Nullable(Type.String()),
  lanes: Open({
    download: Open(PackLane),
    setup: Open({ ...PackLane, step: Nullable(Type.Enum(["checklist", "hotspots"])) }),
    photos: Open(PackLane),
  }),
  catalogProgress: Type.Optional(Nullable(LoadProgress)),
});
const Queued = Type.Optional(
  Type.Integer({ description: "Packs added to the running download's queue, when one was running" }),
);
export const Started = Open({ started: Type.Boolean(), queued: Queued });
export const Cancelled = Open({ cancelled: Type.Boolean() });
export const BatchStarted = Open({ started: Type.Boolean(), queued: Queued, packIds: Type.Array(Type.String()) });

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

export const RemovalStarted = Open({ started: Type.Boolean(), packIds: Type.Array(Type.String()) });

export const RemovalStatus = Open({ ...jobStatusFields(PackDeleted), packIds: Type.Array(Type.String()) });

export const PackProvinces = Open({
  provinces: Type.Array(Open({ id: Type.String(), name: Type.String(), applied: Type.Boolean() })),
  subdivisionLabel: Type.String({ description: 'What the country calls them, like "States"' }),
});
