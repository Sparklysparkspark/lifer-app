// Mirrors the Phase-1 subset of(regions, region_species).

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
  /** Monthly seasonality, 12 entries, index 0 = January — see SeasonalityBar.tsx's own
   *  comment on why this is monthly, not weekly (GBIF's live per-region API only facets by
   *  month). Distinct from weeklyFrequency below, which comes from the bulk province-refresh
   *  path and genuinely is weekly. */
  seasonality: number[] | null;
  /** Weekly occurrence frequency, 52 entries (1 per ISO week), from the bulk GBIF SQL download
   *  in compute-provinces-bulk.ts — null until that script has run for this region. Unlike
   *  seasonality above, this is real week-of-year resolution, not month-bucketed. */
  weeklyFrequency: number[] | null;
}
