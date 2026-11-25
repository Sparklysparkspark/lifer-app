// Response schemas for the Collection routes, and the species card shape other routes reuse
// (trips, albums, region checklists). They document the answer in the OpenAPI document and type
// the web app's calls; fields not listed still pass through.
import { Type } from "typebox";
import { NullableNumbers, Nullable, Open, Uuid } from "../lib/schema.js";

// RarityTier in @lifer/shared.
const Tier = Type.Enum(["common", "occasional", "uncommon", "rare", "legendary", "unrated"]);
const Percent = Nullable(Type.Number());

/** One species card (collectionItem.ts toCollectionItem, plus markNameChanged's flag). */
export const CollectionItem = Open({
  speciesId: Uuid(),
  scientificName: Type.String(),
  commonName: Nullable(Type.String()),
  abaCode: Type.Optional(Nullable(Type.String({ description: "ABA bird code, North American birds only" }))),
  ebirdCode: Type.Optional(Nullable(Type.String({ description: "eBird species code, birds only" }))),
  taxonClass: Nullable(
    Type.String({ description: "A catalog taxon class, or iNaturalist's iconic taxon for an added other taxon" }),
  ),
  family: Nullable(Type.String()),
  taxonOrder: Type.Optional(Nullable(Type.String())),
  state: Type.Enum(["collected", "seen", "unseen"]),
  isTarget: Type.Boolean(),
  needsBetterPhoto: Type.Optional(
    Type.Boolean({ description: "The user (or a connected app) marked it as needing a better photo" }),
  ),
  rawOnly: Type.Optional(
    Type.Boolean({ description: "Collected, and every photo of it is a RAW with no edited version yet" }),
  ),
  tier: Nullable(Tier),
  localTier: Nullable(Tier),
  tierReason: Type.Optional(Nullable(Type.String())),
  localTierReason: Type.Optional(Nullable(Type.String())),
  tierOverridden: Type.Optional(Type.Boolean()),
  nameChanged: Type.Optional(Type.Boolean()),
  vagrant: Type.Boolean(),
  introduced: Type.Boolean(),
  seasonality: NullableNumbers({ description: "12 monthly values, on region checklist rows" }),
  capturedYears: Nullable(Type.Array(Type.Integer())),
  photoCount: Type.Optional(
    Type.Integer({ description: "Your photos of it, videos and recordings aside; Collection and region rows" }),
  ),
  heard: Type.Optional(Type.Boolean()),
  suggested: Type.Optional(
    Type.Boolean({ description: "Collected only through photos Lifer filed, none confirmed yet" }),
  ),
  endemic: Type.Boolean(),
  isGhost: Type.Boolean(),
  isLost: Type.Boolean(),
  rediscoveredGhost: Type.Boolean(),
  rediscoveredLost: Type.Boolean(),
  coverPhotoUrl: Nullable(Type.String()),
  coverPhotoCredit: Nullable(Type.String()),
  cardCropX: Percent,
  cardCropY: Percent,
  cardCropSize: Percent,
  referenceFocalX: Percent,
  referenceFocalY: Percent,
  coverVolumeLabel: Nullable(Type.String()),
  isOtherTaxa: Type.Boolean(),
  inatIconicTaxon: Nullable(Type.String()),
  userAddedRegion: Type.Optional(
    Nullable(Open({ id: Uuid(), name: Type.String(), kind: Type.Enum(["region", "seaZone"]) })),
  ),
});

export const CollectionItems = Open({ items: Type.Array(CollectionItem) });

export const CollectionCount = Open({
  total: Type.Integer(),
  collected: Type.Integer(),
  seen: Type.Integer(),
  suggestedCount: Type.Integer({ description: "Of `collected`, species with no confirmed photo yet" }),
});

export const CollectionStats = Open({
  totalCollected: Type.Integer(),
  // Every tier is always listed, at 0 when none are collected.
  byTier: Open({
    common: Type.Integer(),
    occasional: Type.Integer(),
    uncommon: Type.Integer(),
    rare: Type.Integer(),
    legendary: Type.Integer(),
    unrated: Type.Integer(),
  }),
  byFamily: Type.Array(Open({ family: Type.String(), count: Type.Integer() })),
  byYear: Type.Array(Open({ year: Type.Integer(), count: Type.Integer() })),
  tierRegions: Type.Array(Open({ id: Type.String(), name: Type.String() })),
});

/** No body: the copy the client has (If-None-Match) is still current. */
export const NotModified = Type.Unsafe<void>({ description: "Not modified" });
