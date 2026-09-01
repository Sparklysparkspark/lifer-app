-- Historical/alternate scientific names for a species (old genus assignments, mostly), kept
-- so name-based matching against external data (e.g. a GBIF bulk occurrence download, which
-- reports whatever name its own current taxonomic backbone uses) still resolves to the right
-- species even after our own catalog's scientific_name is updated to a newer accepted name.
CREATE TABLE species_synonyms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  species_id UUID NOT NULL REFERENCES species(id) ON DELETE CASCADE,
  synonym_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (synonym_name)
);

CREATE INDEX species_synonyms_species_id_idx ON species_synonyms(species_id);
