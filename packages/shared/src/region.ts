// Mirrors the Phase-1 subset of (regions, region_species).

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
  /** Monthly seasonality, 12 entries, index 0 = January. GBIF's live per-region API only
   *  facets by month; weeklyFrequency below is the true weekly series. */
  seasonality: number[] | null;
  /** Weekly occurrence frequency, 52 entries (1 per ISO week), from the bulk GBIF SQL download
   *  in compute-provinces-bulk.ts. Null until that script has run for this region. */
  weeklyFrequency: number[] | null;
}
