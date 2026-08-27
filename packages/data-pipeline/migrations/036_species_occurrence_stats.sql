-- Backs the "historically rare / can't find anymore" obscurity signal (fetch-occurrence-stats.ts):
-- GBIF's occurrence records (specimens, herbaria, citizen science) go back to the 1800s, unlike
-- iNaturalist's observations_count which only reflects modern citizen-science activity and can't
-- tell "common but never photographed" apart from "genuinely last seen a century ago." A species
-- with occurrence_count < 20 or last_occurrence_year < 1950 is treated as unfindable-in-practice
-- for the default "hide obscure/inaccessible species" toggle, alongside the depth-based rule for
-- fish (species_traits.depth_min_m/depth_max_m already exist).
ALTER TABLE species_traits ADD COLUMN IF NOT EXISTS occurrence_count integer NULL;
ALTER TABLE species_traits ADD COLUMN IF NOT EXISTS last_occurrence_year integer NULL;
