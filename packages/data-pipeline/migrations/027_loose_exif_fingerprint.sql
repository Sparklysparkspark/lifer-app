-- The strict exif_fingerprint (DateTimeOriginal + SubSecTimeOriginal + Model + SerialNumber)
-- silently fails to match whenever the JPEG went through an export pipeline (Lightroom,
-- Capture One, etc.) — those commonly strip SubSecTimeOriginal and SerialNumber (some as a
-- deliberate privacy default), so an exported JPEG's strict fingerprint differs from its own
-- RAW's even though they're the same shot. A second, looser fingerprint (DateTimeOriginal
-- rounded to the second + Model only) is stored alongside the strict one as a fallback
-- match — tried only when the strict match finds nothing, same "unique match required, else
-- flag for review" safety rule.
ALTER TABLE captures ADD COLUMN exif_fingerprint_loose text NULL;
CREATE INDEX idx_captures_exif_fingerprint_loose ON captures (exif_fingerprint_loose) WHERE exif_fingerprint_loose IS NOT NULL;

ALTER TABLE originals ADD COLUMN exif_fingerprint_loose text NULL;
CREATE INDEX idx_originals_exif_fingerprint_loose ON originals (exif_fingerprint_loose) WHERE exif_fingerprint_loose IS NOT NULL;
