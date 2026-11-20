-- Change tracking for albums, trips, album membership and exclusions, and species name choices,
-- so they sync like captures (150, 152). Tags, trip membership and extra species live on
-- captures_all and ride on the capture's own stamp. Ids are uuids shared by both installs.
-- pushed_at: when this install last sent the row. remote_updated_at: the other side's version
-- of it as last mirrored or pushed, so a push can detect a newer edit there.
ALTER TABLE albums ADD COLUMN pushed_at timestamptz, ADD COLUMN remote_updated_at timestamptz;
ALTER TABLE trips
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN pushed_at timestamptz,
  ADD COLUMN remote_updated_at timestamptz;
UPDATE trips SET updated_at = created_at;
ALTER TABLE album_captures ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN pushed_at timestamptz;
ALTER TABLE album_exclusions ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN pushed_at timestamptz;
ALTER TABLE species_split_kept ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN pushed_at timestamptz;
UPDATE album_captures SET updated_at = added_at;
UPDATE album_exclusions SET updated_at = excluded_at;
UPDATE species_split_kept SET updated_at = kept_at;

CREATE INDEX albums_user_updated_idx ON albums (user_id, updated_at, id);
CREATE INDEX trips_user_updated_idx ON trips (user_id, updated_at, id);

ALTER TABLE sync_tombstones DROP CONSTRAINT sync_tombstones_kind_check;
ALTER TABLE sync_tombstones ADD CONSTRAINT sync_tombstones_kind_check CHECK (kind IN
  ('capture', 'user_species', 'album', 'trip', 'album_capture', 'album_exclusion', 'species_split_kept'));

-- Recording a push, or taking the other side's copy, isn't a change worth sending.
CREATE FUNCTION sync_touch_updated_at() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'pushed_at' - 'remote_updated_at' - 'updated_at')
     = (to_jsonb(OLD) - 'pushed_at' - 'remote_updated_at' - 'updated_at') THEN
    RETURN NEW;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER albums_updated_at BEFORE UPDATE ON albums
  FOR EACH ROW EXECUTE FUNCTION sync_touch_updated_at();
CREATE TRIGGER trips_updated_at BEFORE UPDATE ON trips
  FOR EACH ROW EXECUTE FUNCTION sync_touch_updated_at();
CREATE TRIGGER album_captures_updated_at BEFORE UPDATE ON album_captures
  FOR EACH ROW EXECUTE FUNCTION sync_touch_updated_at();
CREATE TRIGGER album_exclusions_updated_at BEFORE UPDATE ON album_exclusions
  FOR EACH ROW EXECUTE FUNCTION sync_touch_updated_at();
CREATE TRIGGER species_split_kept_updated_at BEFORE UPDATE ON species_split_kept
  FOR EACH ROW EXECUTE FUNCTION sync_touch_updated_at();

-- Set-based, one insert per statement. Rows leaving with their album or capture (a cascade) are
-- skipped: the parent's own tombstone covers them. Deletes under lifer.sync_apply aren't recorded.
CREATE FUNCTION albums_tombstone() RETURNS trigger AS $$
BEGIN
  IF current_setting('lifer.sync_apply', true) = 'on' THEN
    RETURN NULL;
  END IF;
  INSERT INTO sync_tombstones (user_id, kind, ref, base)
    SELECT user_id, 'album', id::text, remote_updated_at FROM gone;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION trips_tombstone() RETURNS trigger AS $$
BEGIN
  IF current_setting('lifer.sync_apply', true) = 'on' THEN
    RETURN NULL;
  END IF;
  INSERT INTO sync_tombstones (user_id, kind, ref, base)
    SELECT user_id, 'trip', id::text, remote_updated_at FROM gone;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION album_captures_tombstone() RETURNS trigger AS $$
BEGIN
  IF current_setting('lifer.sync_apply', true) = 'on' THEN
    RETURN NULL;
  END IF;
  INSERT INTO sync_tombstones (user_id, kind, ref)
    SELECT a.user_id, 'album_capture', g.album_id || ':' || COALESCE(c.remote_id, c.id)
      FROM gone g JOIN albums a ON a.id = g.album_id JOIN captures_all c ON c.id = g.capture_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION album_exclusions_tombstone() RETURNS trigger AS $$
BEGIN
  IF current_setting('lifer.sync_apply', true) = 'on' THEN
    RETURN NULL;
  END IF;
  INSERT INTO sync_tombstones (user_id, kind, ref)
    SELECT a.user_id, 'album_exclusion', g.album_id || ':' || COALESCE(c.remote_id, c.id)
      FROM gone g JOIN albums a ON a.id = g.album_id JOIN captures_all c ON c.id = g.capture_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION species_split_kept_tombstone() RETURNS trigger AS $$
BEGIN
  IF current_setting('lifer.sync_apply', true) = 'on' THEN
    RETURN NULL;
  END IF;
  INSERT INTO sync_tombstones (user_id, kind, ref)
    SELECT c.user_id, 'species_split_kept', COALESCE(c.remote_id, c.id)::text
      FROM gone g JOIN captures_all c ON c.id = g.capture_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER albums_tombstone AFTER DELETE ON albums
  REFERENCING OLD TABLE AS gone FOR EACH STATEMENT EXECUTE FUNCTION albums_tombstone();
CREATE TRIGGER trips_tombstone AFTER DELETE ON trips
  REFERENCING OLD TABLE AS gone FOR EACH STATEMENT EXECUTE FUNCTION trips_tombstone();
CREATE TRIGGER album_captures_tombstone AFTER DELETE ON album_captures
  REFERENCING OLD TABLE AS gone FOR EACH STATEMENT EXECUTE FUNCTION album_captures_tombstone();
CREATE TRIGGER album_exclusions_tombstone AFTER DELETE ON album_exclusions
  REFERENCING OLD TABLE AS gone FOR EACH STATEMENT EXECUTE FUNCTION album_exclusions_tombstone();
CREATE TRIGGER species_split_kept_tombstone AFTER DELETE ON species_split_kept
  REFERENCING OLD TABLE AS gone FOR EACH STATEMENT EXECUTE FUNCTION species_split_kept_tombstone();
