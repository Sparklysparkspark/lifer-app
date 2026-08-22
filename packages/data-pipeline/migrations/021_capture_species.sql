-- Handles a photo depicting more than one species (e.g. a hawk catching a fish).
-- captures.species_id stays as the required PRIMARY species (unchanged meaning — drives file
-- placement, and every existing rarity/collection/region query keeps working exactly as
-- before for it); this table holds only the ADDITIONAL species a photo also depicts. A
-- secondary species counts as fully "collected" the same way the primary does, so the write
-- path upserts user_species for these exactly like the primary, just via this extra table
-- instead of a second column.
CREATE TABLE capture_species (
  capture_id uuid NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  species_id uuid NOT NULL REFERENCES species(id) ON DELETE CASCADE,
  PRIMARY KEY (capture_id, species_id)
);
CREATE INDEX idx_capture_species_species_id ON capture_species (species_id);
