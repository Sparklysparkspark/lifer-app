-- Foreign key check when a photo is deleted; without it every deleted photo scans all captures.
-- Plain (not CONCURRENTLY): migrations run inside a transaction.
CREATE INDEX IF NOT EXISTS idx_captures_all_current_photo ON captures_all (current_photo_id) WHERE current_photo_id IS NOT NULL;
