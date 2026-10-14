-- Originals are always files on disk now: S3 bucket objects are no longer supported, and the
-- 'immich' reference type was never used. A library that still has bucket-backed originals has
-- to move them onto disk (or a mounted library root) first, so this stops rather than drop them.
DO $$
DECLARE
  remaining bigint;
BEGIN
  SELECT count(*) INTO remaining FROM originals WHERE ref_type <> 'path';
  IF remaining > 0 THEN
    RAISE EXCEPTION 'This library has % original(s) stored in an S3 bucket, which Lifer no longer supports. Copy those files onto disk or a mounted library root and import them there, remove the bucket-backed photos, then start Lifer again.', remaining;
  END IF;
END $$;

ALTER TABLE originals DROP CONSTRAINT originals_ref_type_check;
ALTER TABLE originals ADD CONSTRAINT originals_ref_type_check CHECK (ref_type = 'path');

-- Every original records its owner, linked to a capture or not, so ownership checks read one
-- column. Rows written before this carried it only for unlinked RAWs.
UPDATE originals o
SET user_id = c.user_id
FROM captures_all c
WHERE c.id = o.capture_id AND o.user_id IS NULL;
