-- Lets a user hide/archive a species (or, via a bulk client-side loop, a whole family) they
-- don't care about completing — e.g. the many near-identical mice/shrews that pad out a
-- region's "still need to collect" count without anyone actually wanting to go find them.
-- Archiving only affects checklist/count visibility (see obscurity.ts's ALREADY_OWNED_SQL-style
-- exemption pattern, reused here) — it never deletes anything, and an archived species stays
-- reachable via direct species search/the species detail page, so it can always be unarchived.
CREATE TABLE IF NOT EXISTS user_archived_species (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  species_id uuid NOT NULL REFERENCES species(id) ON DELETE CASCADE,
  archived_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, species_id)
);

CREATE INDEX IF NOT EXISTS user_archived_species_user_idx ON user_archived_species (user_id);
