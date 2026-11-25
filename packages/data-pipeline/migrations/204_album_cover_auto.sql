-- The cover photo Lifer picked for an album itself, as opposed to one the user chose. The cover
-- counts as automatic only while cover_photo_id still equals it, so any other write (a pick, a
-- sync, a restore) makes it the user's. Existing covers stay NULL here: nobody can tell who
-- chose them, so they count as chosen and never move on their own.
ALTER TABLE albums
  ADD COLUMN IF NOT EXISTS cover_auto_photo_id uuid REFERENCES photos(id) ON DELETE SET NULL;
