-- What a linked desktop app has sent to its server (sync/push.ts). A capture or species mark is
-- due for a push while pushed_at is null or older than updated_at. remote_id is set only when
-- the server already knew the photo under another id (imported on both sides independently);
-- otherwise the two installs share the id.
ALTER TABLE captures_all ADD COLUMN pushed_at timestamptz, ADD COLUMN remote_id uuid;
CREATE INDEX captures_all_unpushed_idx ON captures_all (user_id)
  WHERE origin = 'local' AND (pushed_at IS NULL OR updated_at > pushed_at);

ALTER TABLE user_species ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN pushed_at timestamptz;

-- Recording a push, or taking the server's copy of a row (which sets pushed_at in the same
-- statement), isn't a change worth pushing: the touch triggers leave updated_at alone when
-- nothing else moved.
CREATE OR REPLACE FUNCTION captures_all_touch_updated_at() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'pushed_at' - 'remote_id' - 'updated_at') = (to_jsonb(OLD) - 'pushed_at' - 'remote_id' - 'updated_at') THEN
    RETURN NEW;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION user_species_touch_updated_at() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'pushed_at' - 'updated_at') = (to_jsonb(OLD) - 'pushed_at' - 'updated_at') THEN
    RETURN NEW;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_species_updated_at BEFORE UPDATE ON user_species
  FOR EACH ROW EXECUTE FUNCTION user_species_touch_updated_at();
