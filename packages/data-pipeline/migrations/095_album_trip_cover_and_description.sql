-- Album/Trip redesign: gives Albums the same cover-crop control Trips already have (migration
-- 047), gives Trips the same description field Albums already have (071), and adds a "quad"
-- cover layout (a 2x2 grid of the album/trip's own most recent photos) as an alternative to a
-- single cropped cover photo, for both.
ALTER TABLE albums
  ADD COLUMN cover_crop_x    numeric NULL CHECK (cover_crop_x BETWEEN 0 AND 100),
  ADD COLUMN cover_crop_y    numeric NULL CHECK (cover_crop_y BETWEEN 0 AND 100),
  ADD COLUMN cover_crop_size numeric NULL CHECK (cover_crop_size > 0 AND cover_crop_size <= 100),
  ADD COLUMN cover_layout    text NOT NULL DEFAULT 'single' CHECK (cover_layout IN ('single', 'quad'));

ALTER TABLE trips
  ADD COLUMN description  text NULL,
  ADD COLUMN cover_layout text NOT NULL DEFAULT 'single' CHECK (cover_layout IN ('single', 'quad'));
