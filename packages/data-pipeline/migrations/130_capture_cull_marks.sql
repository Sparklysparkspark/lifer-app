-- Culling marks read at import (apps/api/src/uploads/cullMarks.ts): the verdict and colour label a
-- culling app such as Lightroom, Photo Mechanic or digiKam left in the file. Kept as the app left
-- them; Lifer's own star rating stays in quality_rating.
ALTER TABLE captures_all ADD COLUMN cull_verdict text CHECK (cull_verdict IN ('pick', 'reject'));
ALTER TABLE captures_all ADD COLUMN cull_label text;

-- Set when a photo the culling app rejected was imported with "import rejected photos hidden".
-- Hidden photos stay out of everything that reads the `captures` view (gallery, life list,
-- stats, albums, search), like trashed ones, but aren't purged: unhiding brings them back.
ALTER TABLE captures_all ADD COLUMN hidden_at timestamptz;
CREATE INDEX captures_all_user_hidden_idx ON captures_all (user_id) WHERE hidden_at IS NOT NULL;

-- A `SELECT *` view freezes its column list (see migration 098), so it's recreated for the new
-- columns, now also leaving hidden photos out.
DROP VIEW captures;
CREATE VIEW captures AS SELECT * FROM captures_all WHERE deleted_at IS NULL AND hidden_at IS NULL;
