-- Permanent snapshot of whether a species was flagged Ghost/Lost at the moment a user actually
-- collected it — distinct from the live isGhost/isLost computed fresh every time from
-- species_traits (see apps/api/src/collection/collectionItem.ts). That live computation is
-- deliberately NOT historical: once fresh occurrence data flows in (say, because someone finally
-- rephotographed a species nobody had documented in decades), it correctly stops showing as Lost
-- for EVERYONE going forward — right for "is this currently hard to find," but it means a user
-- who photographed it back when it genuinely was undocumented would lose all record of that once
-- the global data catches up. These two columns keep that moment: "you helped find something
-- that, at the time, was genuinely Ghost/Lost" — set once, the first time a user_species row is
-- ever marked 'collected', and never touched again afterward regardless of how species_traits
-- changes later.
ALTER TABLE user_species ADD COLUMN was_ghost_when_collected boolean;
ALTER TABLE user_species ADD COLUMN was_lost_when_collected boolean;

-- Mirrors collectionItem.ts's isGhostSpecies/isLostSpecies logic (GHOST_MAX_OCCURRENCE_COUNT=20,
-- LOST_YEARS_SILENT=25, LOST_MIN_YEAR=1950, recreational/technical depth 60/120) closely enough
-- for a one-time historical snapshot. If those thresholds are ever retuned later, this trigger
-- is NOT expected to be updated to match retroactively — the whole point is capturing what was
-- true at the time, not tracking a moving target.
--
-- A database trigger (rather than touching every one of the ~6 TS call sites that INSERT INTO
-- user_species — captures/routes.ts x2, uploads/routes.ts x2, library/reimport.ts,
-- trips/import.ts) is what guarantees this fires for every single one of them, present and
-- future, with no risk of a forgotten call site. The `was_ghost_when_collected IS NULL` guard
-- means it only ever computes once per row: a later UPDATE (a re-upload hitting the same
-- ON CONFLICT DO UPDATE path, a cover-photo change, etc) leaves an already-set snapshot alone.
CREATE OR REPLACE FUNCTION lifer_snapshot_ghost_lost() RETURNS trigger AS $$
DECLARE
  max_depth_m integer;
  v_taxon_class text;
  v_occurrence_count integer;
  v_last_occurrence_year integer;
  v_depth_min_m numeric;
  v_reference_photo text;
  depth_disqualified boolean;
BEGIN
  IF NEW.state = 'collected' AND NEW.first_collected IS NOT NULL AND NEW.was_ghost_when_collected IS NULL THEN
    SELECT COALESCE((SELECT CASE WHEN u.technical_diving THEN 120 ELSE 60 END FROM users u WHERE u.id = NEW.user_id), 60)
      INTO max_depth_m;
    SELECT s.taxon_class, t.occurrence_count, t.last_occurrence_year, t.depth_min_m, s.reference_photo
      INTO v_taxon_class, v_occurrence_count, v_last_occurrence_year, v_depth_min_m, v_reference_photo
      FROM species s LEFT JOIN species_traits t ON t.species_id = s.id
      WHERE s.id = NEW.species_id;

    depth_disqualified := (v_taxon_class = 'actinopterygii' AND v_depth_min_m IS NOT NULL AND v_depth_min_m >= max_depth_m);

    NEW.was_ghost_when_collected := (
      v_occurrence_count IS NOT NULL
      AND NOT depth_disqualified
      AND (v_last_occurrence_year IS NULL OR v_last_occurrence_year >= 1950)
      AND (v_occurrence_count < 20 OR v_reference_photo IS NULL)
    );
    NEW.was_lost_when_collected := (
      v_last_occurrence_year IS NOT NULL
      AND v_last_occurrence_year < EXTRACT(YEAR FROM now())::int - 25
      AND v_last_occurrence_year >= 1950
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lifer_snapshot_ghost_lost_trigger ON user_species;
CREATE TRIGGER lifer_snapshot_ghost_lost_trigger
BEFORE INSERT OR UPDATE ON user_species
FOR EACH ROW EXECUTE FUNCTION lifer_snapshot_ghost_lost();

-- Backfill every already-collected row on this install (a BEFORE UPDATE trigger fires
-- regardless of whether the SET clause actually changes anything, and the function's own
-- `was_ghost_when_collected IS NULL` guard means this only computes the snapshot for rows that
-- don't already have one) — so existing collectors aren't silently excluded from their own
-- collection history just because they collected before this migration existed.
UPDATE user_species SET state = state WHERE state = 'collected';
