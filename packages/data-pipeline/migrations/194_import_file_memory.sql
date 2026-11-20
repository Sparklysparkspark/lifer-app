-- Importing a folder again: files already imported, or left out before, are skipped before upload.

-- The quick hash (movedPhotos/fingerprint.ts) of the file as it was imported. fp_quick_hash follows
-- the stored copy, which changes once Lifer writes metadata into it. Earlier rows start from
-- fp_quick_hash: right for linked files, and a stored copy that no longer matches only falls back to
-- the upload's own duplicate check.
ALTER TABLE originals ADD COLUMN source_quick_hash text NULL;
UPDATE originals SET source_quick_hash = fp_quick_hash WHERE fp_quick_hash IS NOT NULL;
CREATE INDEX idx_originals_source_quick_hash ON originals (user_id, source_quick_hash)
  WHERE source_quick_hash IS NOT NULL;

-- Photos the user left out of an import, so picking the folder again doesn't offer them.
CREATE TABLE import_skipped_files (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  reason      text NOT NULL CHECK (reason IN ('removed', 'not_wildlife', 'no_animal')),
  name        text NOT NULL,
  size        bigint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, fingerprint)
);
CREATE INDEX idx_import_skipped_files_recent ON import_skipped_files (user_id, created_at DESC);

-- Desktop: folders imported from, offered again with a count of their new photos.
CREATE TABLE import_source_folders (
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path             text NOT NULL,
  last_imported_at timestamptz NOT NULL DEFAULT now(),
  photo_count      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, path)
);

-- Each file seen in those folders, so a later look only hashes files whose size or mtime changed.
CREATE TABLE import_source_files (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path       text NOT NULL,
  size       bigint NOT NULL,
  mtime_ms   double precision NOT NULL,
  quick_hash text NOT NULL,
  PRIMARY KEY (user_id, path)
);
