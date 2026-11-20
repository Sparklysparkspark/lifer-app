-- The other side's version of a species mark as last mirrored or pushed, so a push can tell
-- the server changed it since (sync/pushServer.ts). Taking or recording a version isn't an edit.
ALTER TABLE user_species ADD COLUMN remote_updated_at timestamptz;

CREATE OR REPLACE FUNCTION user_species_touch_updated_at() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'pushed_at' - 'remote_updated_at' - 'updated_at' - 'photos_changed_at')
     = (to_jsonb(OLD) - 'pushed_at' - 'remote_updated_at' - 'updated_at' - 'photos_changed_at') THEN
    RETURN NEW;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
