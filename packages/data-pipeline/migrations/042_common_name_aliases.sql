-- Every other English vernacular name GBIF knows for a species (e.g. "Spotfin Frogfish" also
-- goes by "Coin-Bearing Frogfish", "Ocellated Angler", "Big-Spot Angler", etc.) — searched
-- alongside common_name/scientific_name so a search for any real alias still finds the
-- species, instead of only the one name our tie-break logic picked as primary. NULL/empty for
-- a species with only one known name, or not yet backfilled.
ALTER TABLE species ADD COLUMN IF NOT EXISTS common_name_aliases text[] NULL;
CREATE INDEX IF NOT EXISTS idx_species_common_name_aliases ON species USING gin (common_name_aliases);
