-- Smart albums: an album whose photos come from a saved Gallery filter set (rules) instead of
-- hand-picked album_captures rows. NULL rules is a normal album. album_exclusions holds the
-- photos the user took out of a smart album by hand, which its rules would otherwise match.
ALTER TABLE albums ADD COLUMN IF NOT EXISTS rules jsonb;

CREATE TABLE IF NOT EXISTS album_exclusions (
  album_id uuid NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  capture_id uuid NOT NULL REFERENCES captures_all(id) ON DELETE CASCADE,
  excluded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (album_id, capture_id)
);
CREATE INDEX IF NOT EXISTS idx_album_exclusions_capture_id ON album_exclusions (capture_id);
