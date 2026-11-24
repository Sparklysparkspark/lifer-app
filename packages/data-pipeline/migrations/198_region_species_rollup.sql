-- The species of each region's subtree that its own checklist lacks, so the Tree of life can
-- filter by a continent without reading every province's rows (collection/tree.ts). Derived
-- data: the API rebuilds it in the background (apps/api/src/regions/rollup.ts) whenever
-- region_checklist_version has moved past the version it was built from. No foreign keys, so
-- catalog loads and merges never wait on it; a stale row only lasts until the next rebuild.
CREATE TABLE region_species_rollup (
  region_id uuid NOT NULL,
  species_id uuid NOT NULL,
  PRIMARY KEY (region_id, species_id)
);

-- Bumped by any change to which species a region lists or where a region sits. nextval takes
-- no row lock, so concurrent writers never queue on it.
CREATE SEQUENCE region_checklist_version;

CREATE FUNCTION bump_region_checklist_version() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  PERFORM nextval('region_checklist_version');
  RETURN NULL;
END;
$$;

CREATE TRIGGER region_species_checklist_version
  AFTER INSERT OR DELETE OR TRUNCATE OR UPDATE OF region_id, species_id ON region_species
  FOR EACH STATEMENT EXECUTE FUNCTION bump_region_checklist_version();
CREATE TRIGGER regions_checklist_version
  AFTER INSERT OR DELETE OR TRUNCATE OR UPDATE OF parent_id, home_country_id ON regions
  FOR EACH STATEMENT EXECUTE FUNCTION bump_region_checklist_version();
