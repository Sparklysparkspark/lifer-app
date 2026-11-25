-- GET /collection/tree with a region reads the species you hid there, and shares GET /collection's
-- ETag version (migrations 111 and 121), so hiding or restoring one bumps it too.
CREATE TRIGGER region_species_hidden_collection_version
  AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON region_species_hidden
  FOR EACH STATEMENT EXECUTE FUNCTION bump_collection_data_version();
