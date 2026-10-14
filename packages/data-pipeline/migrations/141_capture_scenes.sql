-- What the scene segmentation model (UperNet ConvNeXt-tiny, ADE20K) finds in each capture's
-- photo, for Gallery search words a whole-photo CLIP vector misses ("water", "fence", "purple").
--   labels  {"<ADE20K class>": percent of the frame}, classes covering 1% or more
--   colors  {"<colour name>": percent of the frame}, colours covering 1% or more
-- photo_id is the photo it was computed from: a capture whose current photo changes is redone.
CREATE TABLE IF NOT EXISTS capture_scenes (
  capture_id uuid PRIMARY KEY REFERENCES captures_all(id) ON DELETE CASCADE,
  photo_id uuid NOT NULL,
  model_version text NOT NULL,
  labels jsonb NOT NULL,
  colors jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);
