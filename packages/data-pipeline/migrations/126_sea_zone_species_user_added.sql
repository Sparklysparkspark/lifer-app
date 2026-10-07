-- Species a user added to a sea zone's checklist by hand, like a sea turtle or a seabird the
-- zone's fish and marine mammal list doesn't have. The sea zone counterpart of
-- region_species_user_added (migration 124), and kept apart from the catalog's sea_zone_species
-- for the same reason: a catalog update and every sea zone pack install prune and rewrite that.
-- Per user: on a shared install, one person's additions don't change anyone else's checklist.
CREATE TABLE sea_zone_species_user_added (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sea_zone_id uuid NOT NULL REFERENCES sea_zones(id) ON DELETE CASCADE,
  species_id  uuid NOT NULL REFERENCES species(id) ON DELETE CASCADE,
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, sea_zone_id, species_id)
);

-- The species page lists every sea zone one species was added to.
CREATE INDEX sea_zone_species_user_added_user_species_idx ON sea_zone_species_user_added (user_id, species_id);

-- GET /collection reads this table (an added species counts toward the life list), so a change
-- bumps its ETag like every other table it reads (migrations 111, 121 and 124).
CREATE TRIGGER sea_zone_species_user_added_collection_version
  AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON sea_zone_species_user_added
  FOR EACH STATEMENT EXECUTE FUNCTION bump_collection_data_version();
