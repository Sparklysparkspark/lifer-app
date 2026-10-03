-- Tables GET /collection started reading after migration 111 bump its ETag too: a tier set by
-- hand (115) and a species split or its "keep the old name" choice (118) otherwise left the
-- browser showing the old tier or "Name changed" card.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_tier_overrides', 'species_splits', 'species_split_kept'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_collection_version', t);
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I
         FOR EACH STATEMENT EXECUTE FUNCTION bump_collection_data_version()',
      t || '_collection_version', t);
  END LOOP;
END
$$;
