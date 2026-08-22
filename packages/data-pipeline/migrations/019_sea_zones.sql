-- Real marine polygons (Natural Earth's marine-polys layer — see fetch-marine-zones.ts),
-- not a curated country-adjacency list, per user's explicit choice. A sea zone's species are
-- computed lazily (same pattern as region_species) via GBIF's `geometry` WKT param against
-- the zone's own real (simplified) shape, so results reflect the actual body of water rather
-- than an approximation built from country borders.
CREATE TABLE sea_zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  wkt text NOT NULL,
  bbox_min_lon double precision NOT NULL,
  bbox_min_lat double precision NOT NULL,
  bbox_max_lon double precision NOT NULL,
  bbox_max_lat double precision NOT NULL,
  occurrence_computed_at timestamptz NULL
);

CREATE TABLE sea_zone_species (
  sea_zone_id uuid NOT NULL REFERENCES sea_zones(id) ON DELETE CASCADE,
  species_id uuid NOT NULL REFERENCES species(id) ON DELETE CASCADE,
  record_count int NOT NULL,
  PRIMARY KEY (sea_zone_id, species_id)
);
