// Response schemas for the region routes. They document the answer in the OpenAPI document and
// type the web app's calls; fields not listed still pass through.
import { Type } from "typebox";
import { DateTime, Nullable, Open, Uuid } from "../lib/schema.js";
import { CollectionItem } from "../collection/responses.js";

const GeoJson = Type.Unknown({ description: "A GeoJSON boundary (Natural Earth, public domain)" });

// RegionSummary in @lifer/shared region-api.ts.
export const RegionList = Open({
  regions: Type.Array(
    Open({
      id: Uuid(),
      name: Type.String(),
      parentId: Nullable(Uuid()),
      ebirdRegionCode: Nullable(Type.String()),
      boundaryGeoJson: Nullable(GeoJson),
      hasChildren: Type.Boolean({ description: "Provinces have been added under it" }),
      hasScopedChecklist: Type.Boolean({ description: "False for World and the continents" }),
      sovereigntyGroup: Nullable(Type.String()),
      isSovereignDependency: Type.Boolean(),
    }),
  ),
});

const RegionStats = Open({ total: Type.Integer(), collected: Type.Integer(), seen: Type.Integer() });

// RegionSpeciesResult in @lifer/shared region-api.ts.
export const RegionSpecies = Open({
  needsPack: Type.Optional(Type.Boolean({ description: "The region's pack isn't downloaded yet" })),
  region: Open({
    id: Uuid(),
    name: Type.String(),
    ebirdRegionCode: Nullable(Type.String()),
    boundaryGeoJson: Nullable(GeoJson),
    hasChildren: Type.Boolean(),
    canDrillDown: Type.Boolean(),
  }),
  stats: RegionStats,
  items: Type.Array(CollectionItem),
  taxonPackMissing: Type.Optional(Type.Boolean()),
});

export const AggregateSpecies = Open({
  items: Type.Array(CollectionItem),
  downloadedCountryNames: Type.Array(Type.String()),
});

export const HiddenSpeciesList = Open({
  items: Type.Array(
    Open({
      speciesId: Uuid(),
      scientificName: Type.String(),
      commonName: Nullable(Type.String()),
      referencePhoto: Nullable(Type.String()),
      referenceThumbUrl: Nullable(Type.String()),
      hiddenAt: DateTime(),
      regionId: Uuid(),
      regionName: Type.String(),
      countryId: Nullable(Uuid()),
      countryName: Nullable(Type.String()),
      isCountry: Type.Boolean(),
    }),
  ),
});

export const RegionHiddenSpecies = Open({
  items: Type.Array(
    Open({
      speciesId: Uuid(),
      scientificName: Type.String(),
      commonName: Nullable(Type.String()),
      hiddenAt: DateTime(),
    }),
  ),
});

export const HiddenChildren = Open({
  children: Type.Array(Open({ regionId: Uuid(), regionName: Type.String() })),
});
