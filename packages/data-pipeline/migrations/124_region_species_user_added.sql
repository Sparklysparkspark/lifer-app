-- Species a user added to a region's checklist by hand: a hand-imported Other Taxa species on a
-- second province, or a catalog species the checklist is missing. Kept apart from region_species
-- on purpose. region_species is catalog data that a catalog update and every pack install prune
-- and rewrite, so a row there could vanish on the next update, and removing one could take out a
-- real catalog row. Here the catalog code never looks, removing an addition never touches the
-- catalog, and the checklist can mark these as added by hand.
-- Per user, like region_species_hidden: on a shared install, one person's additions don't change
-- anyone else's checklist.
CREATE TABLE region_species_user_added (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  region_id  uuid NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  species_id uuid NOT NULL REFERENCES species(id) ON DELETE CASCADE,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, region_id, species_id)
);

-- The species page lists every region one species was added to.
CREATE INDEX region_species_user_added_user_species_idx ON region_species_user_added (user_id, species_id);

-- GET /collection reads this table (an added species counts toward the life list), so a change
-- bumps its ETag like every other table it reads (migrations 111 and 121).
CREATE TRIGGER region_species_user_added_collection_version
  AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON region_species_user_added
  FOR EACH STATEMENT EXECUTE FUNCTION bump_collection_data_version();
