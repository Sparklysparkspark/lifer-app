-- Saved spots: named places with coordinates, a region and the iNaturalist geoprivacy to use when a
-- photo taken there is sent. Tracked for sync like trips (163): a version, push bookkeeping and a
-- tombstone on delete. Applying a spot to photos copies its name and coordinates onto them; the
-- spot itself is only a shortcut, so deleting one never changes a photo.
CREATE TABLE saved_spots (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 500),
  lat               numeric NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon               numeric NOT NULL CHECK (lon BETWEEN -180 AND 180),
  region_id         uuid REFERENCES regions(id) ON DELETE SET NULL,
  geoprivacy        text NOT NULL DEFAULT 'open' CHECK (geoprivacy IN ('open', 'obscured', 'private')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  pushed_at         timestamptz,
  remote_updated_at timestamptz
);

CREATE UNIQUE INDEX saved_spots_user_name_idx ON saved_spots (user_id, lower(name));
CREATE INDEX saved_spots_user_updated_idx ON saved_spots (user_id, updated_at, id);

CREATE TRIGGER saved_spots_updated_at BEFORE UPDATE ON saved_spots
  FOR EACH ROW EXECUTE FUNCTION sync_touch_updated_at();

ALTER TABLE sync_tombstones DROP CONSTRAINT sync_tombstones_kind_check;
ALTER TABLE sync_tombstones ADD CONSTRAINT sync_tombstones_kind_check CHECK (kind IN
  ('capture', 'user_species', 'album', 'trip', 'album_capture', 'album_exclusion', 'species_split_kept',
   'saved_spot'));

CREATE FUNCTION saved_spots_tombstone() RETURNS trigger AS $$
BEGIN
  IF current_setting('lifer.sync_apply', true) = 'on' THEN
    RETURN NULL;
  END IF;
  INSERT INTO sync_tombstones (user_id, kind, ref, base)
    SELECT user_id, 'saved_spot', id::text, remote_updated_at FROM gone;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER saved_spots_tombstone AFTER DELETE ON saved_spots
  REFERENCING OLD TABLE AS gone FOR EACH STATEMENT EXECUTE FUNCTION saved_spots_tombstone();
