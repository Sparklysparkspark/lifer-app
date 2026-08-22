-- Consolidates the gallery-only "already tried" flag (migration 011, added this session,
-- never used by real data) into one enriched_at covering reference photo + blurb + gallery
-- together — one lazy fetch pass on first species view, not three separate ones. Also
-- persists Wikidata's P18 image (previously only lived transiently in pipeline memory) so
-- the lazy Commons-fallback path has it at request time.
ALTER TABLE species DROP COLUMN gallery_fetched_at;
ALTER TABLE species ADD COLUMN enriched_at timestamptz NULL;
ALTER TABLE species ADD COLUMN commons_image text NULL;

-- Same "already tried, cache the result" pattern for a region's occurrence counts +
-- seasonality (GBIF calls), computed lazily on first view of that region's species list
-- instead of eagerly for all ~258 countries + ~4600 provinces worldwide at seed time.
ALTER TABLE regions ADD COLUMN occurrence_computed_at timestamptz NULL;
-- Whether this region's child regions (e.g. a country's provinces) have been drilled into
-- yet — distinct from "has zero children", which could also mean "never tried."
ALTER TABLE regions ADD COLUMN has_children boolean NOT NULL DEFAULT false;
