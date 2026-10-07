-- When fetch-occurrence-stats.ts last got an answer from GBIF for a species' occurrence_count and
-- last_occurrence_year (migration 036). A species GBIF has no records for is stored as count 0
-- with no year and this stamp; species that failed used to stay NULL and be fetched again on every
-- refresh. With the stamp, each is looked at again only after --recheck-after-days.
ALTER TABLE species_traits ADD COLUMN IF NOT EXISTS occurrence_checked_at timestamptz NULL;
