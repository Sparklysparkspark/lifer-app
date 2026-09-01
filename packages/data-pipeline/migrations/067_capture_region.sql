-- The import flow already has the user pick a region for every photo (RegionBrowser in
-- PhotoImportRows.tsx, sent as `regionId` to /uploads/inspect for species suggestions), but that
-- choice was never persisted on the resulting capture — only used transiently for suggestion
-- ranking. Storing it lets the Stats page answer "which countries have I actually photographed
-- in" reliably, without depending on GPS EXIF (present on far fewer photos than a region pick,
-- which the import flow already nudges toward with "Pick a region to see species suggestions").
-- Nullable and ON DELETE SET NULL: existing captures predate this column, and a region being
-- deleted/reseeded shouldn't cascade into deleting someone's photos.
-- The real table is captures_all (see migration 061) — `captures` is a `SELECT *` view over it.
-- A `SELECT *` view freezes its column list at CREATE VIEW time in Postgres, so adding a column
-- to captures_all does NOT propagate into the existing view automatically — it has to be
-- recreated, same definition as migration 061's own CREATE VIEW.
ALTER TABLE captures_all ADD COLUMN region_id uuid NULL REFERENCES regions(id) ON DELETE SET NULL;

DROP VIEW captures;
CREATE VIEW captures AS SELECT * FROM captures_all WHERE deleted_at IS NULL;
