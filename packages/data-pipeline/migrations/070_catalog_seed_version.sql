-- Tracks which published catalog-seed version this install has last merged in (see
-- apps/api/src/species/catalogSeedUpdate.ts) — NULL means never applied a merge update (either
-- a fresh install that only ever got the bundled seed, or an install from before this feature
-- existed). Lives on users (single-user app) alongside the other per-install preference columns
-- (hide_obscure_species, technical_diving, etc) rather than a new table, since it's exactly that
-- kind of one-row-per-install setting.
ALTER TABLE users ADD COLUMN catalog_seed_version bigint;
