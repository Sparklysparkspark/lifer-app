-- Phase 7b: RAW indexing (lifer-spec.md §9). A RAW file discovered by scanning a configured
-- root has no capture to belong to yet — it's linked by matching EXIF fingerprints against
-- existing captures, or left for manual review if nothing matches — so `capture_id` can no
-- longer be NOT NULL.
ALTER TABLE originals ALTER COLUMN capture_id DROP NOT NULL;

-- The EXIF-derived fingerprint (DateTimeOriginal + SubSecTimeOriginal + Model + SerialNumber)
-- that spec §8.4 actually means by "fingerprint" — distinct from `captures.fingerprint`,
-- which is a sha256 content hash used for upload dedup, a different concept entirely (see
-- conversation). This is what links a JPEG capture to a separately-discovered RAW sibling.
ALTER TABLE captures ADD COLUMN exif_fingerprint text NULL;
CREATE INDEX idx_captures_exif_fingerprint ON captures (exif_fingerprint) WHERE exif_fingerprint IS NOT NULL;

-- Same fingerprint, stored on an indexed-but-unlinked RAW original so auto-link can match by
-- plain equality once both sides have one.
ALTER TABLE originals ADD COLUMN exif_fingerprint text NULL;
CREATE INDEX idx_originals_exif_fingerprint ON originals (exif_fingerprint) WHERE exif_fingerprint IS NOT NULL;

-- "Scheduled rescan; stale-marking rather than deletion" — a file not seen on the most
-- recent scan of its root gets flagged rather than removed, since a missing file might just
-- be a temporarily unmounted drive.
ALTER TABLE originals ADD COLUMN stale boolean NOT NULL DEFAULT false;

CREATE TABLE scan_roots (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, path)
);

-- "Collision handling: flag for manual resolution, never guess" — recorded rather than
-- silently picking a side when a fingerprint matches more than one original or capture.
CREATE TABLE fingerprint_collisions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exif_fingerprint text NOT NULL,
  original_id      uuid NOT NULL REFERENCES originals(id) ON DELETE CASCADE,
  detected_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz NULL
);
