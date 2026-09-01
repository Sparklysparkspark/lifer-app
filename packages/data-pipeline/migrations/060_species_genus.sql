-- Genus, as a GENERATED column rather than a plain one populated by a one-time backfill —
-- always the first word of a binomial OR trinomial scientific name (a subspecies trinomial's
-- genus is still its first word), so Postgres can maintain it automatically on every future
-- INSERT/UPDATE to species.scientific_name, with no separate backfill script and no risk of
-- a future importer/enrichment path forgetting to set it. STORED (not VIRTUAL — Postgres
-- doesn't support virtual generated columns yet) so it's still a real indexable column.
ALTER TABLE species ADD COLUMN genus text GENERATED ALWAYS AS (split_part(scientific_name, ' ', 1)) STORED;

CREATE INDEX idx_species_genus ON species (genus);
