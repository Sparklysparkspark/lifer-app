-- A small gallery of reference photos per species (from Wikipedia's media list, resolved
-- through Wikimedia Commons), so the species detail page can offer more than one example
-- to compare your own upload against. species.reference_photo/credit/license (migration 001)
-- stays as-is for the collection grid's single thumbnail; this is the expanded set.

CREATE TABLE species_reference_photos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  species_id  uuid NOT NULL REFERENCES species(id) ON DELETE CASCADE,
  photo_url   text NOT NULL,
  credit      text NOT NULL,
  license     text NOT NULL,
  sort_order  int NOT NULL DEFAULT 0,
  UNIQUE (species_id, photo_url)
);

CREATE INDEX idx_species_reference_photos_species_id ON species_reference_photos (species_id, sort_order);
