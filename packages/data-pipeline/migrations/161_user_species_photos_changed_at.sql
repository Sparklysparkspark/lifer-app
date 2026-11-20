-- When a species' photos last changed (added, moved, hidden, trashed, deleted, re-dated, or an
-- extra subject added or removed), so the userdata feed (userdata/routes.ts) can page by it.
-- Kept apart from updated_at so desktop-server sync doesn't re-push unchanged marks.
ALTER TABLE user_species ADD COLUMN photos_changed_at timestamptz;

CREATE OR REPLACE FUNCTION user_species_touch_updated_at() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'pushed_at' - 'updated_at' - 'photos_changed_at')
     = (to_jsonb(OLD) - 'pushed_at' - 'updated_at' - 'photos_changed_at') THEN
    RETURN NEW;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- SKIP LOCKED: a mark another transaction holds is being stamped by it, so concurrent imports
-- and edits on one species neither wait on each other nor deadlock.
CREATE FUNCTION user_species_touch_photos(users uuid[], species uuid[]) RETURNS void AS $$
  UPDATE user_species us SET photos_changed_at = now()
  FROM (SELECT l.user_id, l.species_id FROM user_species l
        JOIN (SELECT DISTINCT * FROM unnest(users, species) AS t(user_id, species_id)) t
          ON t.user_id = l.user_id AND t.species_id = l.species_id
        WHERE l.photos_changed_at IS DISTINCT FROM now()
        FOR UPDATE OF l SKIP LOCKED) x
  WHERE us.user_id = x.user_id AND us.species_id = x.species_id;
$$ LANGUAGE sql;

-- Statement-level, so an import or bulk hide stamps each mark once.
CREATE FUNCTION captures_all_touch_species_photos() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM user_species_touch_photos(array_agg(user_id), array_agg(species_id)) FROM new_rows;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM user_species_touch_photos(array_agg(user_id), array_agg(species_id)) FROM old_rows;
  ELSE
    PERFORM user_species_touch_photos(array_agg(user_id), array_agg(species_id)) FROM (
      WITH moved AS (
        SELECT o.id, o.user_id AS old_user, o.species_id AS old_species, n.user_id AS new_user, n.species_id AS new_species
        FROM old_rows o JOIN new_rows n ON n.id = o.id
        WHERE (o.user_id, o.species_id, o.taken_at, o.deleted_at, o.hidden_at)
              IS DISTINCT FROM (n.user_id, n.species_id, n.taken_at, n.deleted_at, n.hidden_at)
      )
      SELECT old_user AS user_id, old_species AS species_id FROM moved
      UNION ALL SELECT new_user, new_species FROM moved
      UNION ALL SELECT v.u, cs.species_id FROM moved m JOIN capture_species cs ON cs.capture_id = m.id,
        LATERAL (VALUES (m.old_user), (m.new_user)) v(u)
    ) hit;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Transition tables allow one event per trigger.
CREATE TRIGGER captures_all_species_photos_ins AFTER INSERT ON captures_all
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION captures_all_touch_species_photos();
CREATE TRIGGER captures_all_species_photos_upd AFTER UPDATE ON captures_all
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION captures_all_touch_species_photos();
CREATE TRIGGER captures_all_species_photos_del AFTER DELETE ON captures_all
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION captures_all_touch_species_photos();

-- A capture's extra subjects cascade away after the capture row is gone, so its user is
-- unknown by then: stamp them before the delete. Hidden and trashed photos don't count.
CREATE FUNCTION captures_all_touch_extra_species_photos() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM capture_species WHERE capture_id = OLD.id) THEN
    PERFORM user_species_touch_photos(array_agg(OLD.user_id), array_agg(species_id))
      FROM capture_species WHERE capture_id = OLD.id;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER captures_all_extra_species_photos_del BEFORE DELETE ON captures_all
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND OLD.hidden_at IS NULL)
  EXECUTE FUNCTION captures_all_touch_extra_species_photos();

CREATE FUNCTION capture_species_touch_species_photos() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM user_species_touch_photos(array_agg(c.user_id), array_agg(r.species_id))
      FROM new_rows r JOIN captures_all c ON c.id = r.capture_id;
  ELSE
    PERFORM user_species_touch_photos(array_agg(c.user_id), array_agg(r.species_id))
      FROM old_rows r JOIN captures_all c ON c.id = r.capture_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER capture_species_species_photos_ins AFTER INSERT ON capture_species
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION capture_species_touch_species_photos();
CREATE TRIGGER capture_species_species_photos_del AFTER DELETE ON capture_species
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION capture_species_touch_species_photos();
