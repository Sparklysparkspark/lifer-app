-- A RAW uploaded directly on a species' own page (not through the cross-library filename/
-- EXIF matcher) is filed into that species' RAW folder immediately, with no capture to hang
-- off of. species_id is the only way to know which species it belongs to in that case; NULL
-- whenever capture_id is set, since the species is already derivable via
-- capture_id -> captures.species_id there and shouldn't be duplicated (and could drift out
-- of sync with it if it were).
ALTER TABLE originals ADD COLUMN species_id uuid NULL REFERENCES species(id) ON DELETE CASCADE;
CREATE INDEX idx_originals_species_id ON originals (species_id) WHERE species_id IS NOT NULL;
