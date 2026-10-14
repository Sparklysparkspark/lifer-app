// Response schemas for the settings routes. They document the answer in the OpenAPI document and
// type the web app's calls; fields not listed still pass through.
import { Type } from "typebox";
import { Nullable, Open, jobStatusFields } from "../lib/schema.js";

// SettingsResponse in @lifer/shared settings.ts.
export const Settings = Open({
  organizeOriginalsByYear: Type.Boolean(),
  organizeOriginalsByLocation: Type.Boolean(),
  hideObscureSpecies: Type.Boolean(),
  speciesSuggestEnabled: Type.Boolean(),
  anyTaxaSearchEnabled: Type.Boolean(),
  fetchWithheldPhotos: Type.Boolean({ description: "Per install, shared by every account on it" }),
  technicalDiving: Type.Boolean(),
  speciesNamingStyles: Type.Array(Type.String()),
  locale: Nullable(Type.String({ description: "The interface language, or null for automatic" })),
  abaCodesAvailable: Type.Boolean(),
  dataDir: Type.String({ description: "The photo library folder" }),
  deploymentMode: Type.Enum(["desktop", "server"]),
  catalogLoading: Nullable(
    Type.Enum(["running", "failed"], { description: "While a fresh server loads its species catalog" }),
  ),
  libraryRoots: Type.Array(Open({ label: Type.String(), path: Type.String() }), {
    description: "Admin-declared extra library folders; always empty on desktop",
  }),
});

/** A background job's status whose `result` isn't described. */
export const AnyJobStatus = Open(jobStatusFields(Type.Unknown()));

export const StorageLocation = Open({ dataDir: Type.String(), changeable: Type.Boolean() });

export const MapStatus = Open({
  ...jobStatusFields(Type.Unknown()),
  available: Type.Boolean(),
  downloaded: Type.Boolean(),
  sizeBytes: Nullable(Type.Number()),
  downloading: Type.Boolean(),
});

export const EmbeddingModelStatus = Open({
  ...jobStatusFields(Type.Unknown()),
  activeModel: Nullable(Type.Enum(["identification", "general"])),
  downloaded: Type.Boolean(),
  idModelDownloaded: Type.Boolean(),
  sceneModelDownloaded: Type.Boolean(),
  usable: Type.Boolean(),
  sizeBytes: Nullable(Type.Number()),
});

/** The move's outcome, or `started` with ?background=1 (then poll the status route). */
export const ReorganizeOutcome = Open({
  started: Type.Optional(Type.Boolean()),
  moved: Type.Optional(Type.Integer()),
  skipped: Type.Optional(Type.Integer()),
  failed: Type.Optional(Type.Integer()),
  total: Type.Optional(Type.Integer()),
  lastError: Type.Optional(Nullable(Type.String())),
});

/** The move's outcome, or `started` with ?background=1 (then poll the status route). */
export const StorageMoveOutcome = Open({
  started: Type.Optional(Type.Boolean()),
  dataDir: Type.Optional(Type.String()),
  previousDataDir: Type.Optional(Type.String()),
  filesMoved: Type.Optional(Type.Boolean()),
  restartRequired: Type.Optional(Type.Boolean()),
});
