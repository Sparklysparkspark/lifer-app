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
  taxonClass: Nullable(
    Type.String({ description: "A catalog taxon class, or iNaturalist's iconic taxon for an added other taxon" }),
  ),
  family: Nullable(Type.String()),
  taxonOrder: Type.Optional(Nullable(Type.String())),
  state: Type.Enum(["collected", "seen", "unseen"]),
  isTarget: Type.Boolean(),
  tier: Nullable(Tier),
  localTier: Nullable(Tier),
  tierReason: Type.Optional(Nullable(Type.String())),
  localTierReason: Type.Optional(Nullable(Type.String())),
  tierOverridden: Type.Optional(Type.Boolean()),
  nameChanged: Type.Optional(Type.Boolean()),
  vagrant: Type.Boolean(),
  seasonality: NullableNumbers({ description: "12 monthly values, on region checklist rows" }),
  capturedYears: Nullable(Type.Array(Type.Integer())),
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

export const CollectionCount = Open({ total: Type.Integer(), collected: Type.Integer(), seen: Type.Integer() });

export const CollectionStats = Open({
  totalCollected: Type.Integer(),
  byTier: Type.Record(Type.String(), Type.Integer()),
  byFamily: Type.Array(Open({ family: Type.String(), count: Type.Integer() })),
  byYear: Type.Array(Open({ year: Type.Integer(), count: Type.Integer() })),
  tierRegions: Type.Array(Open({ id: Type.String(), name: Type.String() })),
});

/** No body: the copy the client has (If-None-Match) is still current. */
export const NotModified = Type.Unsafe<void>({ description: "Not modified" });
