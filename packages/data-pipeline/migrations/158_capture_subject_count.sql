-- How many animals the detector found in a capture's photo, for Gallery search by number of
-- animals. NULL until counted (at import, or by the background catch-up for older photos).
ALTER TABLE captures_all ADD COLUMN subject_count smallint CHECK (subject_count >= 0);

-- A `SELECT *` view freezes its column list (see migrations 098 and 130), so it's recreated.
DROP VIEW captures;
CREATE VIEW captures AS SELECT * FROM captures_all WHERE deleted_at IS NULL AND hidden_at IS NULL;

-- Each install counts its own photos, so filling the count in isn't an edit worth syncing.
CREATE OR REPLACE FUNCTION captures_all_touch_updated_at() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'pushed_at' - 'remote_id' - 'remote_updated_at' - 'subject_count' - 'updated_at')
     = (to_jsonb(OLD) - 'pushed_at' - 'remote_id' - 'remote_updated_at' - 'subject_count' - 'updated_at') THEN
    RETURN NEW;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
