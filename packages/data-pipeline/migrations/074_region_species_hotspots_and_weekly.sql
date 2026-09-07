-- Locality-level clusters within a (region, species) pair, so the trip-planning gap finder can
-- answer "which town/park/lake," not just "which province" (region_species.local_tier alone).
-- Computed inline by compute-provinces-bulk.ts from occurrence points it already parses — see
-- that script's own comment on grid-based clustering, and its eBird-sensitive-species /
-- basisOfRecord guardrails.
CREATE TABLE region_species_hotspots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  region_id        uuid NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  species_id       uuid NOT NULL REFERENCES species(id) ON DELETE CASCADE,
  centroid_lat     double precision NOT NULL,
  centroid_lon     double precision NOT NULL,
  point_count      int NOT NULL,
  bbox_diagonal_km double precision NOT NULL
);
CREATE INDEX idx_region_species_hotspots_region_species ON region_species_hotspots (region_id, species_id);

-- Weekly (not monthly) occurrence frequency per (region, species), 52 entries, 1-indexed ISO
-- week stored at array index (week - 1). Distinct from region_species.seasonality (monthly,
-- populated by the live per-region path in regions/routes.ts) — this comes from the bulk GBIF
-- SQL download's own weekofyear() grouping, which the live path's per-species API calls can't
-- afford (would be 52x the request volume instead of 12x).
ALTER TABLE region_species ADD COLUMN weekly_frequency int[];
