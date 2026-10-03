-- Indexes behind the gallery, duplicate check, RAW matching, and photo delete cascades.

-- Every photo to capture join, purge, and the cascade from captures_all.
CREATE INDEX IF NOT EXISTS idx_photos_capture_id ON photos (capture_id);

-- Duplicate check on every inspected photo.
CREATE INDEX IF NOT EXISTS idx_captures_all_user_fingerprint ON captures_all (user_id, fingerprint);

-- Gallery default sort.
CREATE INDEX IF NOT EXISTS idx_captures_all_user_taken_at ON captures_all (user_id, taken_at DESC NULLS LAST, id);

-- Reverse lookups from a capture to its albums, and the cascade on delete.
CREATE INDEX IF NOT EXISTS idx_album_captures_capture_id ON album_captures (capture_id);

-- Foreign key checks when a photo is deleted.
CREATE INDEX IF NOT EXISTS idx_user_species_cover_photo ON user_species (cover_photo_id) WHERE cover_photo_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_albums_cover_photo ON albums (cover_photo_id) WHERE cover_photo_id IS NOT NULL;

-- Unlinked RAW originals waiting to be paired with an edited JPEG.
CREATE INDEX IF NOT EXISTS idx_originals_unlinked_raw ON originals (user_id) WHERE capture_id IS NULL AND kind = 'raw';
