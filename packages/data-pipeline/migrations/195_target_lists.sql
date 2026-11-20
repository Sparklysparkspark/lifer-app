-- Named target lists, general (no region) or for one region, filled by a CSV import.
-- user_species.is_target stays the one "is a target" flag everything reads (cards, sync, export).
-- A list sets it for its species; removing a list clears it only for species on no other list
-- that weren't targets before any list took them (`direct`).
CREATE TABLE target_lists (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 500),
  region_id  uuid NULL REFERENCES regions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_target_lists_user ON target_lists (user_id);

CREATE TABLE target_list_species (
  list_id    uuid NOT NULL REFERENCES target_lists(id) ON DELETE CASCADE,
  species_id uuid NOT NULL REFERENCES species(id) ON DELETE CASCADE,
  -- The species was a target (flagged by hand) before any list held it, so no list removal clears it.
  direct     boolean NOT NULL DEFAULT false,
  PRIMARY KEY (list_id, species_id)
);
CREATE INDEX idx_target_list_species_species ON target_list_species (species_id);
