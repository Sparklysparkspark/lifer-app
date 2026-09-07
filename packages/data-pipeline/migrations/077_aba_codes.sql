-- ABA (American Birding Association) 4-letter codes — a different system from the existing
-- unused `ebird_code` column (eBird's own 6-letter species codes). ABA codes only cover birds
-- within the ABA checklist area (the US and Canada), so this is nullable and left unpopulated
-- for every other species — a real backfill script (packages/data-pipeline) sources ABA's own
-- published code list and matches it in by scientific name, not part of this migration.
ALTER TABLE species ADD COLUMN aba_code text NULL;

-- A global naming-style preference (mirrors organize_originals_by_year's own shape — a plain
-- column on `users`, not a separate settings table) controlling what folder names and EXIF
-- species tags use: the existing common-name behavior, or ABA codes where the species has one
-- (falling back to the common name otherwise, handled in application code, not here).
ALTER TABLE users ADD COLUMN species_naming_style text NOT NULL DEFAULT 'common_name';
