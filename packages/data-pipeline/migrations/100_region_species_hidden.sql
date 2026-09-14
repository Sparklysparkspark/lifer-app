-- Region-scoped species archive: hides a species from ONE region's checklist without touching
-- its global record or its presence on any other region's checklist. Deliberately separate from
-- user_archived_species (migration 037) rather than reusing/overloading it — that table hides a
-- species everywhere, which is the wrong tool for e.g. archiving Japanese Quail off a BC/Canada
-- checklist (a vagrant entry there) while still wanting it to show up when browsing Japan.
CREATE TABLE region_species_hidden (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  region_id  uuid NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  species_id uuid NOT NULL REFERENCES species(id) ON DELETE CASCADE,
  hidden_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, region_id, species_id)
);

CREATE INDEX region_species_hidden_user_region_idx ON region_species_hidden (user_id, region_id);
