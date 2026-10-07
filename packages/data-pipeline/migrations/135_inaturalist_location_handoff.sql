-- Sending to iNaturalist no longer invents a location. A photo without GPS is sent with no
-- coordinates (the observation stays Casual until the user places it on iNaturalist), so what
-- was sent can be empty. Rows from before keep the region-centre guess they were sent with.
ALTER TABLE capture_inaturalist_observations
  ALTER COLUMN submitted_lat DROP NOT NULL,
  ALTER COLUMN submitted_lon DROP NOT NULL,
  ALTER COLUMN submitted_positional_accuracy DROP NOT NULL;

-- Where a photo's coordinates came from: NULL for the camera's own GPS (or anything earlier),
-- 'inaturalist' for a location the user placed on iNaturalist and Lifer copied back. With it,
-- how precise a placed location is, in metres, when iNaturalist recorded that.
ALTER TABLE captures_all ADD COLUMN location_source text CHECK (location_source IN ('inaturalist'));
ALTER TABLE captures_all ADD COLUMN location_accuracy_m numeric;

-- A `SELECT *` view freezes its column list (see migrations 098 and 130), so it's recreated.
DROP VIEW captures;
CREATE VIEW captures AS SELECT * FROM captures_all WHERE deleted_at IS NULL AND hidden_at IS NULL;
