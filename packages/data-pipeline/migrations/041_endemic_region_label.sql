-- Richer, human-written display label for a verified single-country endemic species (e.g.
-- "the Nile" instead of just "Egypt"), extracted from Wikipedia summary text (via iNaturalist)
-- by backfill-endemic-region-label.ts. NULL means either the species isn't endemic, or no
-- richer label could be extracted — the API falls back to the plain country name in that case.
ALTER TABLE species_traits ADD COLUMN IF NOT EXISTS endemic_region_label text NULL;

-- Set alongside endemic_country_iso3 corrections so re-runs can skip species already checked
-- (this pass also re-verifies/corrects endemic_country_iso3 itself against a direct,
-- un-gated GBIF per-species country facet — see that column's own comment in 018_endemic.sql
-- for why the original compute-elusiveness.ts crawl can mislabel a real multi-country species
-- as single-country-endemic).
ALTER TABLE species_traits ADD COLUMN IF NOT EXISTS endemic_checked_at timestamptz NULL;
