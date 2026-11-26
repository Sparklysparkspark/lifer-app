-- Smart tag decisions (docs/plans/smart-tags.md, ST-3). These are the user's choices, so unlike the
-- suggestions (migration 207) they sync. An accepted smart tag is an ordinary photo tag in
-- captures_all.tags, stored under its canonical US facet path (Habitat|Wetland); spelling by
-- region is applied only when shown or written.
--   smart_tags_accepted  term id -> the path it added to tags: the "smart-tagged" marker, so Lifer
--                        tells it from a typed tag and keeps it out of files until the switch is on
--   smart_tags_rejected  term ids never to suggest for this photo again, whatever the vocabulary
-- Both ride the capture's own updated_at (whole-row compare, migration 152), like tags.
ALTER TABLE captures_all
  ADD COLUMN smart_tags_accepted jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(smart_tags_accepted) = 'object'),
  ADD COLUMN smart_tags_rejected text[] NOT NULL DEFAULT '{}';

-- An accepted tag the user removed (tag editor, rename, delete, a sync) counts as rejected, so it
-- is never suggested again. A sender that leaves the columns out (NULL) keeps this side's values.
-- Runs before the NOT NULL check, which Postgres makes after BEFORE triggers.
CREATE FUNCTION captures_all_smart_tags_follow_tags() RETURNS trigger AS $$
DECLARE
  gone text[];
BEGIN
  IF NEW.smart_tags_accepted IS NULL THEN
    NEW.smart_tags_accepted := CASE WHEN TG_OP = 'UPDATE' THEN OLD.smart_tags_accepted ELSE '{}' END;
  END IF;
  IF NEW.smart_tags_rejected IS NULL THEN
    NEW.smart_tags_rejected := CASE WHEN TG_OP = 'UPDATE' THEN OLD.smart_tags_rejected ELSE '{}' END;
  END IF;
  SELECT array_agg(key) INTO gone FROM jsonb_each_text(NEW.smart_tags_accepted)
    WHERE NOT (value = ANY (COALESCE(NEW.tags, '{}')));
  IF gone IS NOT NULL THEN
    NEW.smart_tags_accepted := NEW.smart_tags_accepted - gone;
    NEW.smart_tags_rejected := ARRAY(SELECT DISTINCT unnest(NEW.smart_tags_rejected || gone));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER captures_all_smart_tags BEFORE INSERT OR UPDATE OF tags, smart_tags_accepted, smart_tags_rejected
  ON captures_all FOR EACH ROW EXECUTE FUNCTION captures_all_smart_tags_follow_tags();

-- Vocabulary terms the user turned off for every photo ("Never suggest Wetland"). A set per user,
-- synced like the other library sets (migration 163): updated_at, pushed_at and a tombstone.
CREATE TABLE smart_tag_hidden_terms (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  term_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  pushed_at timestamptz,
  PRIMARY KEY (user_id, term_id)
);
CREATE INDEX smart_tag_hidden_terms_updated_idx ON smart_tag_hidden_terms (user_id, updated_at, term_id);
CREATE TRIGGER smart_tag_hidden_terms_updated_at BEFORE UPDATE ON smart_tag_hidden_terms
  FOR EACH ROW EXECUTE FUNCTION sync_touch_updated_at();

ALTER TABLE sync_tombstones DROP CONSTRAINT sync_tombstones_kind_check;
ALTER TABLE sync_tombstones ADD CONSTRAINT sync_tombstones_kind_check CHECK (kind IN
  ('capture', 'user_species', 'album', 'trip', 'album_capture', 'album_exclusion', 'species_split_kept',
   'saved_spot', 'species_list', 'smart_tag_hidden'));

CREATE FUNCTION smart_tag_hidden_terms_tombstone() RETURNS trigger AS $$
BEGIN
  IF current_setting('lifer.sync_apply', true) = 'on' THEN
    RETURN NULL;
  END IF;
  INSERT INTO sync_tombstones (user_id, kind, ref) SELECT user_id, 'smart_tag_hidden', term_id FROM gone;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER smart_tag_hidden_terms_tombstone AFTER DELETE ON smart_tag_hidden_terms
  REFERENCING OLD TABLE AS gone FOR EACH STATEMENT EXECUTE FUNCTION smart_tag_hidden_terms_tombstone();

-- Undo for accept and reject batches: per photo and term, the decision before the batch ('none',
-- 'accepted' or 'rejected'). Local and short lived: tokens expire, nothing here is synced.
CREATE TABLE smart_tag_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capture_ids uuid[] NOT NULL,
  term_ids text[] NOT NULL,
  prev text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz
);
CREATE INDEX smart_tag_batches_created_idx ON smart_tag_batches (created_at);
