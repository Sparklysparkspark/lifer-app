-- Species picker search (GET /species): one indexed row per searchable name instead of an OR
-- across un-indexed alias/genus/family/code columns, which scanned the whole catalog per keystroke.
-- A --disable-triggers seed restore (desktop first boot) leaves the table empty; species/routes.ts
-- rebuilds it on startup when that happens.

-- Diacritic-insensitive matching. unaccent ships in contrib (the Docker image and the desktop's
-- bundled Postgres both have it); if it's missing, fall back to translate() for common Latin
-- diacritics so the migration never fails on an install without contrib.
-- Every name inside these functions is schema-qualified: a pg_dump restore runs with an empty
-- search_path and still evaluates the species family index expression below.
DO $$
DECLARE
  ext_schema text;
  here text := current_schema();
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS unaccent;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'unaccent unavailable (%), using translate() fallback', SQLERRM;
  END;
  SELECT n.nspname INTO ext_schema
  FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'unaccent';

  IF ext_schema IS NOT NULL THEN
    EXECUTE format($f$
      CREATE OR REPLACE FUNCTION %1$I.lifer_unaccent(t text) RETURNS text
      LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS
      $body$ SELECT %2$I.unaccent(%3$L::regdictionary, t) $body$
    $f$, here, ext_schema, quote_ident(ext_schema) || '.unaccent');
  ELSE
    EXECUTE format($f$
      CREATE OR REPLACE FUNCTION %1$I.lifer_unaccent(t text) RETURNS text
      LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS
      $body$ SELECT pg_catalog.translate(t,
        'ÀÁÂÃÄÅàáâãäåÇçÈÉÊËèéêëÌÍÎÏìíîïÑñÒÓÔÕÖØòóôõöøÙÚÛÜùúûüÝýÿŠšŽžČčĆćĐđŁłŃńŚśŹźŻżŘřŤťŮůĚěŇňĎďĽľ',
        'AAAAAAaaaaaaCcEEEEeeeeIIIIiiiiNnOOOOOOooooooUUUUuuuuYyySsZzCcCcDdLlNnSsZzZzRrTtUuEeNnDdLl') $body$
    $f$, here);
  END IF;

  -- lower + unaccent, hyphens/underscores/slashes to spaces, apostrophes dropped, whitespace
  -- collapsed: "Cooper's Hawk" = "coopers hawk", "Black-capped" = "black capped".
  -- GET /species normalizes the typed text with this same function.
  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION %1$I.lifer_search_norm(t text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS
    $body$ SELECT pg_catalog.btrim(pg_catalog.regexp_replace(
      pg_catalog.regexp_replace(pg_catalog.lower(%1$I.lifer_unaccent(t)), '[''’`]', '', 'g'),
      '[[:space:]_/-]+', ' ', 'g')) $body$
  $f$, here);
END
$$;

CREATE TABLE species_search_names (
  species_id uuid NOT NULL REFERENCES species(id) ON DELETE CASCADE,
  name text NOT NULL,
  name_norm text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('common', 'scientific', 'alias', 'synonym', 'code')),
  PRIMARY KEY (species_id, kind, name_norm)
);

-- Rebuilds the rows for the given species (every species when ids is NULL). Called by the
-- triggers below, so seed merges, pack installs and Other Taxa additions stay in sync on their own.
CREATE OR REPLACE FUNCTION refresh_species_search_names(ids uuid[] DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  -- Dynamic SQL so a targeted refresh is planned with its ids and uses the primary keys,
  -- instead of a cached generic plan that scans the whole catalog.
  sp text := CASE WHEN ids IS NULL THEN 'species' ELSE '(SELECT * FROM species WHERE id = ANY($1))' END;
  syn text := CASE WHEN ids IS NULL THEN 'species_synonyms' ELSE '(SELECT * FROM species_synonyms WHERE species_id = ANY($1))' END;
BEGIN
  IF ids IS NULL THEN
    DELETE FROM species_search_names;
  ELSE
    DELETE FROM species_search_names WHERE species_id = ANY(ids);
  END IF;

  EXECUTE format($q$
    INSERT INTO species_search_names (species_id, name, name_norm, kind)
    SELECT species_id, name, lifer_search_norm(name), kind
    FROM (
      SELECT s.id AS species_id, s.common_name AS name, 'common' AS kind FROM %1$s s
      UNION ALL SELECT s.id, s.scientific_name, 'scientific' FROM %1$s s
      UNION ALL SELECT s.id, a, 'alias' FROM %1$s s, unnest(s.common_name_aliases) a
      UNION ALL SELECT ss.species_id, ss.synonym_name, 'synonym' FROM %2$s ss
      UNION ALL SELECT s.id, s.ebird_code, 'code' FROM %1$s s
      UNION ALL SELECT s.id, s.aba_code, 'code' FROM %1$s s
    ) n
    WHERE name IS NOT NULL AND btrim(name) <> ''
    ON CONFLICT DO NOTHING
  $q$, sp, syn) USING ids;
END;
$$;

-- Statement-level triggers with transition tables: one set-based refresh per statement, so a
-- 130k-row catalog load costs one pass rather than 130k trigger calls. Large batches rebuild all.
CREATE OR REPLACE FUNCTION species_search_names_sync() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  changed uuid[];
BEGIN
  IF TG_TABLE_NAME = 'species' THEN
    IF TG_OP = 'INSERT' THEN
      SELECT array_agg(id) INTO changed FROM new_rows;
    ELSE
      SELECT array_agg(n.id) INTO changed
      FROM new_rows n JOIN old_rows o ON o.id = n.id
      WHERE (n.common_name, n.scientific_name, n.common_name_aliases, n.ebird_code, n.aba_code)
        IS DISTINCT FROM (o.common_name, o.scientific_name, o.common_name_aliases, o.ebird_code, o.aba_code);
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT species_id) INTO changed FROM new_rows;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT species_id) INTO changed FROM old_rows;
  ELSE
    SELECT array_agg(DISTINCT x) INTO changed FROM (
      SELECT n.species_id AS x FROM new_rows n
      UNION SELECT o.species_id FROM old_rows o
    ) u;
  END IF;

  IF changed IS NULL THEN
    RETURN NULL;
  ELSIF cardinality(changed) > 20000 THEN
    PERFORM refresh_species_search_names(NULL);
  ELSE
    PERFORM refresh_species_search_names(changed);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER species_search_names_ins AFTER INSERT ON species
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION species_search_names_sync();
CREATE TRIGGER species_search_names_upd AFTER UPDATE ON species
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION species_search_names_sync();
CREATE TRIGGER species_search_names_syn_ins AFTER INSERT ON species_synonyms
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION species_search_names_sync();
CREATE TRIGGER species_search_names_syn_upd AFTER UPDATE ON species_synonyms
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION species_search_names_sync();
CREATE TRIGGER species_search_names_syn_del AFTER DELETE ON species_synonyms
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION species_search_names_sync();

-- Populate before building the search indexes: bulk-building them is several times faster.
SELECT refresh_species_search_names(NULL);
CREATE INDEX species_search_names_trgm_idx ON species_search_names USING gin (name_norm gin_trgm_ops);
CREATE INDEX species_search_names_prefix_idx ON species_search_names (name_norm text_pattern_ops);
-- Family prefix search ("Anatidae" lists every duck) reads species directly; one row per species
-- in the search table would double its size for a low-ranked match.
CREATE INDEX species_family_norm_idx ON species (lifer_search_norm(family) text_pattern_ops);

-- Collection ETag (collection/routes.ts): any write to a table GET /collection reads bumps this
-- sequence. nextval takes no row lock, so concurrent writers never queue on it.
CREATE SEQUENCE collection_data_version;

CREATE OR REPLACE FUNCTION bump_collection_data_version() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  PERFORM nextval('collection_data_version');
  RETURN NULL;
END;
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'species', 'species_rarity', 'species_traits', 'user_species', 'user_archived_species',
    'photos', 'captures_all', 'originals', 'storage_volumes', 'regions', 'region_species',
    'downloaded_packs', 'sea_zones', 'sea_zone_species'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I
         FOR EACH STATEMENT EXECUTE FUNCTION bump_collection_data_version()',
      t || '_collection_version', t);
  END LOOP;
END
$$;
