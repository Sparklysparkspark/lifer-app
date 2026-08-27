-- Tracks which species have already been checked against GBIF's IUCN-sourced distribution data
-- for a real EXTINCT status (see fetch-occurrence-stats.ts's occurrence_count/last_occurrence_year,
-- which this reuses to narrow the huge no-photo/legendary candidate pool down to ones with a
-- real historical-rarity signal worth spending a GBIF call on) — lets the check script be
-- re-run repeatedly as the occurrence-stats backfill fills in more species, without
-- re-querying GBIF for species already checked and confirmed still-current.
ALTER TABLE species_traits ADD COLUMN IF NOT EXISTS extinction_checked_at timestamptz NULL;
