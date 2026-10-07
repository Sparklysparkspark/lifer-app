-- One line describing the database's contents, run before the upgrade (on the old major) and
-- after it (on the new one); the two must be identical. Used by pg-upgrade-test.sh and the
-- pg_upgrade_* tests in src/pg_upgrade.rs.
SELECT concat_ws(' | ',
  (SELECT count(*) FROM schema_migrations),
  (SELECT md5(string_agg(filename, ',' ORDER BY filename)) FROM schema_migrations),
  (SELECT count(*) FROM species),
  (SELECT md5(string_agg(gbif_key || scientific_name || coalesce(common_name, '') || coalesce(family, ''), ',' ORDER BY gbif_key)) FROM species),
  (SELECT count(*) FROM species_search_names),
  (SELECT md5(string_agg(name_norm, ',' ORDER BY name_norm)) FROM species_search_names),
  (SELECT count(*) FROM upgrade_sentinel),
  (SELECT md5(string_agg(id || name || name_digest, ',' ORDER BY id)) FROM upgrade_sentinel),
  (SELECT bool_and(name_digest = encode(digest(name, 'sha256'), 'hex')) FROM upgrade_sentinel),
  (SELECT string_agg(extname, ',' ORDER BY extname) FROM pg_extension),
  (SELECT string_agg(indexname, ',' ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public'),
  lifer_unaccent('Garza Ñandú Héron'),
  (SELECT count(*) FROM upgrade_sentinel WHERE name % 'Nandu comun 42'),
  (SELECT count(*) FROM species_search_names WHERE name_norm % lifer_search_norm('Ñandú Héron'))
);
