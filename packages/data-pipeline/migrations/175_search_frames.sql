-- Gallery search by composition, light and background (plan N-07).
--   box     the detector's best animal box [x1, y1, x2, y2] as fractions of the upright photo, or NULL
--   aspect  the upright photo's width / height
--   light   {"luma", "warmth", "highlights", "shadows", "saturation"}, each 0 to 1 (warmth -1 to 1)
-- photo_id is the photo it was read from: a capture whose current photo changes is redone.
CREATE TABLE capture_frames (
  capture_id uuid PRIMARY KEY REFERENCES captures_all(id) ON DELETE CASCADE,
  photo_id uuid NOT NULL,
  version text NOT NULL,
  box real[] CHECK (box IS NULL OR cardinality(box) = 4),
  box_unsure boolean NOT NULL,
  aspect real NOT NULL,
  light jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);

-- The CLIP vector of the photo with the animal greyed out, for "a tree in the background". Only for
-- photos where the animal leaves enough of the frame to read.
CREATE TABLE capture_background_embeddings (
  capture_id uuid PRIMARY KEY REFERENCES captures_all(id) ON DELETE CASCADE,
  photo_id uuid NOT NULL,
  embedding real[] NOT NULL,
  model_version text NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);

-- Whether the file said which time zone its capture time is in. NULL: imported before this was
-- recorded. Without a zone the sun's position from the time can be hours off.
ALTER TABLE captures_all ADD COLUMN taken_at_zoned boolean;

-- A `SELECT *` view freezes its column list (see migration 158), so it's recreated.
DROP VIEW captures;
CREATE VIEW captures AS SELECT * FROM captures_all WHERE deleted_at IS NULL AND hidden_at IS NULL;
