-- Named places: a saved spot gets a radius (what counts as inside it, and the accuracy sent to
-- iNaturalist), a locality worked out once from its point, notes, where it came from, and when it
-- was last used (for the picker's Recent group).
ALTER TABLE saved_spots
  ADD COLUMN radius_m integer NOT NULL DEFAULT 100 CHECK (radius_m BETWEEN 25 AND 5000),
  ADD COLUMN locality text CHECK (char_length(locality) <= 300),
  ADD COLUMN locality_source text CHECK (locality_source IN ('gazetteer', 'region', 'inaturalist', 'user')),
  ADD COLUMN notes text CHECK (char_length(notes) <= 2000),
  ADD COLUMN origin text NOT NULL DEFAULT 'map' CHECK (origin IN ('map', 'photo', 'inaturalist')),
  ADD COLUMN last_used_at timestamptz;

-- Using a place isn't an edit worth syncing (like inat_ignored_at on captures, migration 177).
CREATE FUNCTION saved_spots_touch_updated_at() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'pushed_at' - 'remote_updated_at' - 'last_used_at' - 'updated_at')
     = (to_jsonb(OLD) - 'pushed_at' - 'remote_updated_at' - 'last_used_at' - 'updated_at') THEN
    RETURN NEW;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER saved_spots_updated_at ON saved_spots;
CREATE TRIGGER saved_spots_updated_at BEFORE UPDATE ON saved_spots
  FOR EACH ROW EXECUTE FUNCTION saved_spots_touch_updated_at();

-- Where a photo's point came from, so a place never replaces camera GPS silently: 'spot' for a
-- place's centre, 'map' for a point placed or typed. NULL stays "camera or unknown"; earlier
-- placings can't be told apart and are treated as camera.
ALTER TABLE captures_all DROP CONSTRAINT captures_all_location_source_check;
ALTER TABLE captures_all ADD CONSTRAINT captures_all_location_source_check
  CHECK (location_source IN ('inaturalist', 'spot', 'map'));
