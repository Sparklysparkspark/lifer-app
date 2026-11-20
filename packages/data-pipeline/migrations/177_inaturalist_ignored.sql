-- Photos the user chose never to send to iNaturalist: left out of the To send tab, Send all and
-- the Gallery's "Not on iNaturalist" filter until restored. NULL means not ignored.
ALTER TABLE captures_all ADD COLUMN inat_ignored_at timestamptz;

-- A `SELECT *` view freezes its column list (see migrations 098 and 130), so it's recreated.
DROP VIEW captures;
CREATE VIEW captures AS SELECT * FROM captures_all WHERE deleted_at IS NULL AND hidden_at IS NULL;

-- iNaturalist sending is per install (its observation links don't sync), so ignoring a photo
-- isn't an edit worth syncing either.
CREATE OR REPLACE FUNCTION captures_all_touch_updated_at() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'pushed_at' - 'remote_id' - 'remote_updated_at' - 'subject_count' - 'inat_ignored_at' - 'updated_at')
     = (to_jsonb(OLD) - 'pushed_at' - 'remote_id' - 'remote_updated_at' - 'subject_count' - 'inat_ignored_at' - 'updated_at') THEN
    RETURN NEW;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
