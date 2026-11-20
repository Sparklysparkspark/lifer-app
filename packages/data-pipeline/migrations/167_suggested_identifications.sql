-- Whether a photo's species is one the user chose or one Lifer filed from a confident match inside
-- the region's checklist (apps/api/src/captures/identification.ts). Everything that exists today
-- was chosen by the user, so the default is 'confirmed'; only the analysis of a folder files
-- 'suggested', and any edit by the user confirms.
ALTER TABLE captures_all
  ADD COLUMN identification_state text NOT NULL DEFAULT 'confirmed'
    CHECK (identification_state IN ('suggested', 'confirmed')),
  -- The match percentage a suggestion was filed with, for the review queue's ordering.
  ADD COLUMN suggestion_percent smallint CHECK (suggestion_percent BETWEEN 0 AND 100);

-- A `SELECT *` view freezes its column list (see migrations 098, 130 and 158), so it's recreated.
DROP VIEW captures;
CREATE VIEW captures AS SELECT * FROM captures_all WHERE deleted_at IS NULL AND hidden_at IS NULL;

-- The review queue reads one user's unconfirmed photos.
CREATE INDEX captures_all_suggested ON captures_all (user_id, taken_at)
  WHERE identification_state = 'suggested' AND deleted_at IS NULL;
