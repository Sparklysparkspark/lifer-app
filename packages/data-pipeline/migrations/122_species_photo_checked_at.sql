-- When the pipeline last looked for a photo for a species that has none
-- (scripts/recheck-null-photo-species.ts). Rechecking every photoless species on every refresh
-- spent iNaturalist's daily request allowance on species with no photo Lifer may publish; with
-- this, each is looked at again only after a while.
ALTER TABLE species ADD COLUMN photo_checked_at timestamptz NULL;
