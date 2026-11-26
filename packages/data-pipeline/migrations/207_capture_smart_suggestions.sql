-- Smart tag suggestions (docs/plans/smart-tags.md, ST-2), worked out from what Lifer already stores
-- per photo (sun, date, scene and colour shares, detector count, CLIP vector). Derived and local:
-- never synced, and emptying both tables only makes the background pass evaluate every photo again.
--   term_id  a vocabulary term id (packages/shared/src/smartTags/vocab.json)
--   score    0 to 1, strongest first when reviewing a term
--   source   computed (stored signals), scene (scene shares confirmed by CLIP) or clip
CREATE TABLE capture_smart_suggestions (
  capture_id uuid NOT NULL REFERENCES captures_all(id) ON DELETE CASCADE,
  term_id text NOT NULL,
  score real NOT NULL,
  source text NOT NULL CHECK (source IN ('computed', 'scene', 'clip')),
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (capture_id, term_id)
);
-- Review goes by term: counts per term and a term's photos, strongest first.
CREATE INDEX capture_smart_suggestions_term ON capture_smart_suggestions (term_id, score DESC);

-- When each photo was last evaluated: under which vocabulary, calibration, engine and model
-- (version), and from which stored inputs (a hash of their timestamps). A change in either
-- evaluates the photo again, from stored data only.
CREATE TABLE capture_smart_tag_state (
  capture_id uuid PRIMARY KEY REFERENCES captures_all(id) ON DELETE CASCADE,
  version text NOT NULL,
  inputs text NOT NULL,
  evaluated_at timestamptz NOT NULL DEFAULT now()
);
