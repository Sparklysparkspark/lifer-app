-- Pairs of photos the user said are not a similar group worth reviewing ("Keep all", "Not similar").
-- A dismissed pair is never linked again (apps/api/src/gallery/similar.ts), while a new photo can
-- still join either one. Stored as an ordered pair so each is kept once.
CREATE TABLE similar_dismissals (
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capture_a uuid NOT NULL REFERENCES captures_all(id) ON DELETE CASCADE,
  capture_b uuid NOT NULL REFERENCES captures_all(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, capture_a, capture_b),
  CHECK (capture_a < capture_b)
);

-- Lookups by the other photo of a pair, which the primary key doesn't cover.
CREATE INDEX similar_dismissals_b ON similar_dismissals (capture_b);
