-- "Also add these species to my targets" on a list from iNaturalist: while set, every species the
-- list adds also goes on this target list (target_list_species, migration 195), page by page in
-- the worker's transaction. NULL is off. target_photographed also targets species already
-- photographed; otherwise only the ones not photographed yet.
ALTER TABLE species_lists
  ADD COLUMN IF NOT EXISTS target_list_id uuid REFERENCES target_lists(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS target_photographed boolean NOT NULL DEFAULT false;
