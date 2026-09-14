-- Quad cover layout (095_album_trip_cover_and_description.sql) always auto-picked its 4 photos
-- as "most recently added" with no user control over which photos or how each is framed. These
-- columns make both explicit and optional: NULL keeps the existing auto-pick behavior, a real
-- array overrides it. quad_crops mirrors the single-cover cover_crop_x/y/size shape per slot
-- (index-aligned with quad_photo_ids) rather than 12 new numeric columns.
ALTER TABLE albums
  ADD COLUMN quad_photo_ids uuid[] NULL,
  ADD COLUMN quad_crops     jsonb NULL;

ALTER TABLE trips
  ADD COLUMN quad_photo_ids uuid[] NULL,
  ADD COLUMN quad_crops     jsonb NULL;
