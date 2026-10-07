-- Leftovers nothing reads. scan_roots (M013) was a "watch a root folder" design never wired up;
-- trips replaced it (M046) and nothing ever inserted a row. users.catalog_seed_version (M070)
-- moved to install_settings in M103, since the catalog belongs to the install, not an account.
DROP TABLE scan_roots;
ALTER TABLE users DROP COLUMN catalog_seed_version;
