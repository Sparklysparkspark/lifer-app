-- Deletions that sync between a desktop app and its linked server (sync/changes.ts, sync/push.ts):
-- a row for every capture or species mark deleted outright, so the other side drops it too rather
-- than keeping it or sending it back. ref is the capture's id as the server knows it, or the
-- species' scientific name (species ids differ between installs). base is the server version the
-- desktop last had of the capture, so a deletion from the desktop never overrides a newer edit
-- on the server. Deletes made while applying the other side's changes set lifer.sync_apply and
-- aren't recorded, so they don't echo back. No foreign key: a user's rows are deleted with the user.
CREATE TABLE sync_tombstones (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('capture', 'user_species')),
  ref text NOT NULL,
  base timestamptz,
  deleted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sync_tombstones_user_idx ON sync_tombstones (user_id, deleted_at, ref);

-- On a desktop: the server's updated_at for this capture as last mirrored or pushed, sent with
-- the next push so the server can tell whether it changed since.
ALTER TABLE captures_all ADD COLUMN remote_updated_at timestamptz;

CREATE OR REPLACE FUNCTION captures_all_touch_updated_at() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'pushed_at' - 'remote_id' - 'remote_updated_at' - 'updated_at')
     = (to_jsonb(OLD) - 'pushed_at' - 'remote_id' - 'remote_updated_at' - 'updated_at') THEN
    RETURN NEW;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION captures_all_tombstone() RETURNS trigger AS $$
BEGIN
  IF current_setting('lifer.sync_apply', true) = 'on' THEN
    RETURN NULL;
  END IF;
  INSERT INTO sync_tombstones (user_id, kind, ref, base)
    SELECT user_id, 'capture', COALESCE(remote_id, id)::text, remote_updated_at FROM gone;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER captures_all_tombstone AFTER DELETE ON captures_all
  REFERENCING OLD TABLE AS gone FOR EACH STATEMENT EXECUTE FUNCTION captures_all_tombstone();

CREATE FUNCTION user_species_tombstone() RETURNS trigger AS $$
BEGIN
  IF current_setting('lifer.sync_apply', true) = 'on' THEN
    RETURN NULL;
  END IF;
  INSERT INTO sync_tombstones (user_id, kind, ref)
    SELECT g.user_id, 'user_species', s.scientific_name FROM gone g JOIN species s ON s.id = g.species_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_species_tombstone AFTER DELETE ON user_species
  REFERENCING OLD TABLE AS gone FOR EACH STATEMENT EXECUTE FUNCTION user_species_tombstone();
