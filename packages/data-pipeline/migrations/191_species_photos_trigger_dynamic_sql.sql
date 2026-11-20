-- Same as 161, but the update branch runs through EXECUTE: a cached plan from a small first
-- update on a pooled connection is otherwise reused for a bulk update and runs for minutes.
CREATE OR REPLACE FUNCTION captures_all_touch_species_photos() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM user_species_touch_photos(array_agg(user_id), array_agg(species_id)) FROM new_rows;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM user_species_touch_photos(array_agg(user_id), array_agg(species_id)) FROM old_rows;
  ELSE
    EXECUTE $q$
      SELECT user_species_touch_photos(array_agg(user_id), array_agg(species_id)) FROM (
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
      ) hit
    $q$;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
