-- A file the user has explicitly marked "don't keep asking about this" during a library
-- import/reimport review (e.g. a folder of insect photos this app doesn't track) — keyed by
-- content hash, not path, so it stays recognized even if the file gets moved or renamed.
CREATE TABLE ignored_library_files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_hash text NOT NULL,
  ignored_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, content_hash)
);
