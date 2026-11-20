-- The card photo the user picked for a species themselves (the card-photo action), as opposed to
-- one Lifer chose. The cover counts as picked only while cover_photo_id still equals it, so code
-- that picks covers automatically doesn't need to touch this column.
ALTER TABLE user_species
  ADD COLUMN IF NOT EXISTS cover_chosen_photo_id uuid REFERENCES photos(id) ON DELETE SET NULL;
