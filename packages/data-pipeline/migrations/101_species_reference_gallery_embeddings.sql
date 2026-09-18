-- Species auto-suggest currently only ever compares a candidate photo against ONE stored vector
-- per species (species_reference_embeddings, migration 058), computed from the single main
-- reference photo. A real photo taken at a different angle/pose than that one reference image
-- (e.g. a heron in flight vs. a perched portrait) can legitimately score below the confidence
-- cutoff even though a human would recognize it instantly. One embedding per gallery photo
-- fixes this cheaply: an embedding is ~3KB regardless of how large the source photo was, so
-- shipping one per gallery photo (there can be several per species) costs almost nothing next
-- to the images themselves, and matching can take the best score across all of them instead of
-- just the one.
--
-- Keyed on species_reference_photos.id (one embedding per gallery photo, not per species) rather
-- than duplicating (species_id, photo_url). species_id is kept alongside anyway so a candidate
-- query can filter by it directly without an extra join back through species_reference_photos.
CREATE TABLE species_reference_gallery_embeddings (
  reference_photo_id uuid PRIMARY KEY REFERENCES species_reference_photos(id) ON DELETE CASCADE,
  species_id uuid NOT NULL REFERENCES species(id) ON DELETE CASCADE,
  embedding real[] NOT NULL,
  model_version text NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX species_reference_gallery_embeddings_species_idx ON species_reference_gallery_embeddings (species_id);
