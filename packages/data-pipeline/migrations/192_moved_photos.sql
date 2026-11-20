-- Moved photos: a cheap identity for every original, so a file moved or renamed inside the places
-- photos live is found again. Capture time and camera serial are already in exif_fingerprint.
ALTER TABLE originals
  -- sha1 of the size, the first 64 KB and the last 64 KB.
  ADD COLUMN fp_quick_hash text NULL,
  ADD COLUMN fp_size       bigint NULL,
  ADD COLUMN fp_mtime      timestamptz NULL,
  -- "dev:ino" (the file index on Windows); trusted only with a matching size and quick hash.
  ADD COLUMN fp_file_id    text NULL;

CREATE INDEX idx_originals_fp_pending ON originals (id) WHERE fp_quick_hash IS NULL AND ref_type = 'path';
CREATE INDEX idx_originals_fp_file_id ON originals (fp_file_id) WHERE fp_file_id IS NOT NULL;

ALTER TABLE users ADD COLUMN find_moved_photos boolean NOT NULL DEFAULT true;

-- Folders the user says photos live in, on top of the library, trip and watched folders.
CREATE TABLE photo_places (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, path)
);

-- The last walk of the places: a folder whose mtime is unchanged still holds the files listed.
CREATE TABLE seen_folders (
  path     text PRIMARY KEY,
  parent   text NULL,
  mtime_ms double precision NOT NULL
);
CREATE INDEX idx_seen_folders_parent ON seen_folders (parent);

CREATE TABLE seen_files (
  path       text PRIMARY KEY,
  folder     text NOT NULL,
  -- Lower-case file name, for the edited-in-place fallback.
  name       text NOT NULL,
  size       bigint NOT NULL,
  mtime_ms   double precision NOT NULL,
  file_id    text NULL,
  -- Read only for files sized like a missing photo; cleared when size or mtime changes.
  quick_hash text NULL
);
CREATE INDEX idx_seen_files_folder ON seen_files (folder);
CREATE INDEX idx_seen_files_size ON seen_files (size);
CREATE INDEX idx_seen_files_name ON seen_files (name);
CREATE INDEX idx_seen_files_file_id ON seen_files (file_id) WHERE file_id IS NOT NULL;

-- Each set of relinks, so Undo puts the old paths (and a trip's old folders) back.
CREATE TABLE relink_batches (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at           timestamptz NOT NULL DEFAULT now(),
  undone_at            timestamptz NULL,
  -- Shown once as a toast.
  announced            boolean NOT NULL DEFAULT false,
  trip_id              uuid NULL REFERENCES trips(id) ON DELETE SET NULL,
  old_source_folder    text NULL,
  old_destination_folder text NULL,
  new_source_folder    text NULL,
  new_destination_folder text NULL
);
CREATE INDEX idx_relink_batches_user ON relink_batches (user_id, created_at DESC);

CREATE TABLE relink_changes (
  batch_id                 uuid NOT NULL REFERENCES relink_batches(id) ON DELETE CASCADE,
  original_id              uuid NOT NULL REFERENCES originals(id) ON DELETE CASCADE,
  old_ref                  text NOT NULL,
  old_volume_id            uuid NULL,
  old_volume_relative_path text NULL,
  new_ref                  text NOT NULL,
  PRIMARY KEY (batch_id, original_id)
);

-- Matches Lifer won't guess: several candidates, or probably the same file edited in place.
CREATE TABLE moved_photo_reviews (
  original_id  uuid PRIMARY KEY REFERENCES originals(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  candidates   text[] NOT NULL,
  reason       text NOT NULL CHECK (reason IN ('several', 'probably')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Skipped by the user: not offered again for the same candidates.
  dismissed_at timestamptz NULL
);
CREATE INDEX idx_moved_photo_reviews_user ON moved_photo_reviews (user_id) WHERE dismissed_at IS NULL;

-- "This trip's folder moved to <folder>. Use it?"
CREATE TABLE trip_folder_proposals (
  trip_id      uuid PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder       text NOT NULL,
  found        integer NOT NULL,
  total        integer NOT NULL,
  announced    boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  dismissed_at timestamptz NULL
);
