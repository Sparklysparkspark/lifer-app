-- Sentinel data for the PostgreSQL major upgrade test (pg-upgrade-test.sh), loaded into a fully
-- migrated database on the old major. It exercises what the upgrade must carry over: rows in
-- Lifer's own tables (their statement triggers fill species_search_names through lifer_unaccent),
-- a trigram index, an expression index over unaccent, and pgcrypto digests.
\set ON_ERROR_STOP 1
INSERT INTO species (gbif_key, scientific_name, common_name, taxon_class, family)
SELECT 990000000 + g,
       'Ardea sentinella ' || g,
       CASE WHEN g = 1 THEN 'Garza Ñandú Héron' ELSE 'Sentinel heron ' || g END,
       'Aves',
       CASE WHEN g % 2 = 0 THEN 'Ardéidae' ELSE 'Anatidae' END
FROM generate_series(1, 2000) g;

CREATE TABLE upgrade_sentinel (
  id int PRIMARY KEY,
  name text NOT NULL,
  name_digest text NOT NULL
);
INSERT INTO upgrade_sentinel
SELECT g, 'Ñandú común ' || g, encode(digest('Ñandú común ' || g, 'sha256'), 'hex')
FROM generate_series(1, 5000) g;
CREATE INDEX upgrade_sentinel_trgm ON upgrade_sentinel USING gin (name gin_trgm_ops);
CREATE INDEX upgrade_sentinel_unaccent ON upgrade_sentinel (lifer_unaccent(name));
ANALYZE;
