-- Duplicate catalog species folded into one (the same species under an old and a current name,
-- e.g. Oceanodroma melania and Hydrobates melania). The catalog seed carries these rows, and a
-- catalog update applies them (species/speciesMerges.ts): everything an install has on the old
-- entry, photos and collected state included, moves to the surviving one, then the old entry goes.
-- old_species_id has no foreign key on purpose: the old species row is deleted once merged.
CREATE TABLE species_merges (
  old_species_id uuid PRIMARY KEY,
  new_species_id uuid NOT NULL REFERENCES species(id) ON DELETE CASCADE,
  old_scientific_name text NOT NULL,
  merged_at timestamptz NOT NULL DEFAULT now(),
  CHECK (old_species_id <> new_species_id)
);
