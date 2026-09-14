-- Other Taxa species (added one at a time via Settings > Species & Import, no pack/checklist
-- of their own — see species/routes.ts's resolveOrCreateOtherTaxaSpecies) are a tiny fraction
-- of the species table, but the region-rollup query added to GET /regions/:id/species (and its
-- /count and /regions/taxon-presence siblings) filters on is_other_taxa with no index to use,
-- forcing a full sequential scan of the whole species table on every request. A partial index
-- (tiny, since is_other_taxa is true for only a handful of rows) turns that into a fast index
-- scan instead.
CREATE INDEX idx_species_is_other_taxa ON species (id) WHERE is_other_taxa = true;

-- region_species' own PK is (region_id, species_id) — great for "species in this region," but
-- the reverse lookup ("which regions is this ONE (rare, is_other_taxa) species in") the same
-- rollup queries also need can't use a composite index on its non-leading column at all; without
-- this, Postgres fell back to effectively scanning the whole index. species_id alone is rare
-- enough (matches only the handful of Other Taxa species) that this index stays small.
CREATE INDEX idx_region_species_species_id ON region_species (species_id);
