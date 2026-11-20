-- Sound recordings: an audio capture has the same rows as a photo or video capture. Only the two
-- kind checks widen. The photos row holds a waveform image (display_path, thumb_path) and
-- duration_seconds; the originals row holds the untouched recording.
ALTER TABLE originals DROP CONSTRAINT originals_kind_check;
ALTER TABLE originals ADD CONSTRAINT originals_kind_check CHECK (kind IN ('raw', 'jpeg', 'video', 'audio'));

ALTER TABLE photos DROP CONSTRAINT photos_kind_check;
ALTER TABLE photos ADD CONSTRAINT photos_kind_check CHECK (kind IN ('image', 'video', 'audio'));
