-- When each capture last changed, so an integration syncing through the API (GET /captures?since=)
-- can fetch only what changed since its last run: new photos, and edits to species, rating, tags,
-- location or capture time, plus moves to and from the trash (deleted_at).
ALTER TABLE captures_all ADD COLUMN updated_at timestamptz;
UPDATE captures_all SET updated_at = COALESCE(deleted_at, created_at);
ALTER TABLE captures_all ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE captures_all ALTER COLUMN updated_at SET DEFAULT now();

CREATE FUNCTION captures_all_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER captures_all_updated_at BEFORE UPDATE ON captures_all
  FOR EACH ROW EXECUTE FUNCTION captures_all_touch_updated_at();

-- Adding or removing an extra species on a photo is a change to that photo too.
CREATE FUNCTION capture_species_touch_capture() RETURNS trigger AS $$
BEGIN
  UPDATE captures_all SET updated_at = now() WHERE id = COALESCE(NEW.capture_id, OLD.capture_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER capture_species_touch_capture AFTER INSERT OR DELETE ON capture_species
  FOR EACH ROW EXECUTE FUNCTION capture_species_touch_capture();

CREATE INDEX captures_all_user_updated_idx ON captures_all (user_id, updated_at, id);
