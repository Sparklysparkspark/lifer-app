// The shapes of the JSON this server downloads: the pack index, the photo store's index, and a
// pack's manifest. Each is checked where it's fetched, so a malformed or tampered file fails
// with a clear message instead of reaching the download checks with fields missing. Extra fields
// are allowed, so a newer publish still works.
import { Type, type Static, type TSchema } from "typebox";
import { Compile } from "typebox/compile";

const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const PackIndexEntrySchema = Type.Object({
  id: Type.String(),
  type: Type.Union([Type.Literal("region"), Type.Literal("seaZone")]),
  region: Type.Optional(Type.String()),
  seaZone: Type.Optional(Type.String()),
  taxon: Type.Optional(Nullable(Type.String())),
  // "small" has the same checklist and embeddings as "full" but one reference photo per
  // species. Absent means "full".
  variant: Type.Optional(Type.Union([Type.Literal("full"), Type.Literal("small")])),
  sizeBytes: Type.Number(),
  speciesCount: Type.Number(),
  // Hash of the pack's manifest, so a downloaded pack is recognized as stale when it changes.
  contentVersion: Type.String(),
  // Every species in the pack and its bundled provinces, deduplicated. Used by /recommend.
  scientificNames: Type.Array(Type.String()),
  // The pack store shard it's in, the bytes of it that are this pack, and their SHA-256
  // (data-pipeline's pipeline/packStore.ts).
  url: Type.String(),
  range: Type.Optional(Type.Tuple([Type.Number(), Type.Number()])),
  sha256: Type.Optional(Type.String()),
  // Pack ids (not zone names: a zone has one pack per taxon) of the sea zones a region pack
  // depends on, so the client can group them under their country.
  seaZoneDependencies: Type.Optional(Type.Array(Type.String())),
});

export const PackIndexSchema = Type.Object({
  generatedAt: Type.String(),
  /** Where pack photos are fetched from (offlinePacks/photoStore.ts). */
  photoStore: Type.Optional(Type.Object({ indexUrl: Type.String() })),
  packs: Type.Array(PackIndexEntrySchema),
});

const PhotoRefSchema = Type.Tuple([Type.Number(), Type.Number(), Type.Number(), Type.String()]);
const PhotoPairSchema = Type.Object({ d: Type.Optional(PhotoRefSchema), t: Type.Optional(PhotoRefSchema) });

export const PhotoStoreIndexSchema = Type.Object({
  v: Type.Literal(1),
  builtAt: Type.String(),
  shards: Type.Array(Type.Object({ name: Type.String(), bytes: Type.Number(), sha256: Type.String() })),
  species: Type.Record(
    Type.String(),
    Type.Object({
      d: Type.Optional(PhotoRefSchema),
      t: Type.Optional(PhotoRefSchema),
      g: Type.Optional(Type.Record(Type.String(), PhotoPairSchema)),
    }),
  ),
});

// Mirrors build-region-pack.ts's ManifestSpecies, so a pack works offline without live fetches.
const ManifestSpeciesSchema = Type.Object({
  scientificName: Type.String(),
  habitatDescription: Type.Optional(Nullable(Type.String())),
  referenceCredit: Type.Optional(Nullable(Type.String())),
  referenceLicense: Type.Optional(Nullable(Type.String())),
  displayFile: Type.Optional(Nullable(Type.String())),
  thumbFile: Type.Optional(Nullable(Type.String())),
  gallery: Type.Optional(
    Type.Array(
      Type.Object({
        photoUrl: Type.String(),
        credit: Type.String(),
        license: Type.String(),
        // It names the photo's file, so apply.ts skips any photo whose value isn't an integer
        // rather than failing the whole pack.
        sortOrder: Type.Unknown(),
        focalX: Nullable(Type.Number()),
        focalY: Nullable(Type.Number()),
        displayFile: Nullable(Type.String()),
        thumbFile: Nullable(Type.String()),
        embedding: Type.Optional(Type.Array(Type.Number())),
        embeddingModelVersion: Type.Optional(Type.String()),
      }),
    ),
  ),
  embedding: Type.Optional(Type.Array(Type.Number())),
  embeddingModelVersion: Type.Optional(Type.String()),
  // Checklist membership. A sea-zone pack only has recordCount.
  localFrequency: Type.Optional(Nullable(Type.Number())),
  seasonality: Type.Optional(Nullable(Type.Array(Type.Number()))),
  localTier: Type.Optional(Nullable(Type.String())),
  isVagrant: Type.Optional(Type.Boolean()),
  recordCount: Type.Optional(Type.Number()),
  // Why the tier is what it is, or why there's none (packages/shared tierExplain.ts).
  tierReason: Type.Optional(Nullable(Type.String())),
  tierExplain: Type.Optional(Type.Unknown()),
  weeklyFrequency: Type.Optional(Nullable(Type.Array(Type.Number()))),
  // Province level only.
  hotspots: Type.Optional(
    Type.Array(
      Type.Object({
        centroidLat: Type.Number(),
        centroidLon: Type.Number(),
        pointCount: Type.Number(),
        bboxDiagonalKm: Type.Number(),
        lastSeenYear: Nullable(Type.Number()),
        distinctYears: Nullable(Type.Number()),
      }),
    ),
  ),
});

const manifestRegionFields = {
  name: Type.String(),
  ebirdRegionCode: Type.Optional(Nullable(Type.String())),
  boundaryGeoJson: Type.Unknown(),
  externalCodes: Type.Array(Type.String()),
  species: Type.Array(ManifestSpeciesSchema),
  isOverseasTerritory: Type.Optional(Type.Boolean()),
};

// A province, or a regional group with its provinces inside (country > group > province).
const ManifestChildRegionSchema = Type.Object({
  ...manifestRegionFields,
  children: Type.Optional(Type.Array(Type.Object(manifestRegionFields))),
});

export const PackManifestSchema = Type.Object({
  type: Type.Union([Type.Literal("region"), Type.Literal("seaZone")]),
  region: Type.Optional(Type.String()),
  seaZone: Type.Optional(Type.String()),
  // The one taxon class the pack covers, or null for every taxon. When absent the pack only adds
  // to a checklist (see pruneChecklist in apply.ts).
  taxon: Type.Optional(Nullable(Type.String())),
  species: Type.Array(ManifestSpeciesSchema),
  // Regional groups and provinces bundled into a country pack, applied like the country (the
  // local row is created if missing).
  children: Type.Optional(Type.Array(ManifestChildRegionSchema)),
  seaZoneDependencies: Type.Optional(Type.Array(Type.Object({ name: Type.String(), packFile: Type.String() }))),
});

export type PackIndexEntry = Static<typeof PackIndexEntrySchema>;
export type PackIndex = Static<typeof PackIndexSchema>;
export type PhotoRef = Static<typeof PhotoRefSchema>;
export type PhotoStoreIndex = Static<typeof PhotoStoreIndexSchema>;
export type ManifestSpecies = Static<typeof ManifestSpeciesSchema>;
export type PackManifest = Static<typeof PackManifestSchema>;

const validators = new Map<TSchema, ReturnType<typeof Compile>>();

/** `value` as `schema`'s type, or an error naming `what` and the first field that's wrong. */
export function parseRemoteJson<T extends TSchema>(schema: T, value: unknown, what: string): Static<T> {
  let validator = validators.get(schema);
  if (!validator) {
    validator = Compile(schema);
    validators.set(schema, validator);
  }
  if (validator.Check(value)) return value as Static<T>;
  const [first] = validator.Errors(value);
  const where = first ? ` (${first.instancePath || "/"} ${first.message})` : "";
  throw new Error(`The ${what} isn't in the expected format${where}`);
}
