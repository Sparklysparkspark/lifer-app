-- A free-text place name the user types themselves at import time (e.g. "Prince George") —
-- deliberately independent of the exact lat/lon EXIF/GPS coordinates already on captures_all,
-- which iNaturalist-style precision handles separately. This is for organizing/browsing by a
-- place a human actually recognizes, not a coordinate.
ALTER TABLE captures_all ADD COLUMN IF NOT EXISTS location_label text NULL;

-- Same "toggle only changes future uploads" contract as organize_originals_by_year.
ALTER TABLE users ADD COLUMN IF NOT EXISTS organize_originals_by_location boolean NOT NULL DEFAULT false;
