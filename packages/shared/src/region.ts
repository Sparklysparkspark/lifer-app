// Mirrors the Phase-1 subset of lifer-spec.md §6 (regions, region_species).

export interface Region {
  id: string;
  name: string;
  parentId: string | null;
  /** WKT polygon/multipolygon, used for GBIF occurrence queries. Null until geocoded. */
  gbifAreaWkt: string | null;
  externalCodes: string[];
}

export interface RegionSpecies {
  regionId: string;
  speciesId: string;
  localFrequency: number | null;
  /** Weekly seasonality, 52 entries, index 0 = first week of year. */
  seasonality: number[] | null;
}
