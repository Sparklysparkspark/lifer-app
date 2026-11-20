-- How the animal in a photo looks: life stage, sex, plumage and colour morph (docs/plans/photo-appearance.md).
-- Life stage and sex are short fixed lists, so they're checked here; iNaturalist's Life Stage and
-- Sex annotations map onto them. Plumage and morph are open ended across taxa ("first winter",
-- "dark morph", "blue phase"), so they're free text with suggestions, capped for the UI.
-- NULL means not set; sex 'unknown' means looked at and can't tell.
-- The updated_at trigger compares whole rows, so editing these syncs like any other capture edit.
ALTER TABLE captures_all
  ADD COLUMN life_stage text CHECK (life_stage IN ('egg', 'larva', 'nymph', 'pupa', 'juvenile', 'subadult', 'adult')),
  ADD COLUMN sex text CHECK (sex IN ('male', 'female', 'unknown')),
  ADD COLUMN plumage text CHECK (char_length(btrim(plumage)) BETWEEN 1 AND 100),
  ADD COLUMN morph text CHECK (char_length(btrim(morph)) BETWEEN 1 AND 100);

-- A `SELECT *` view freezes its column list (see migrations 098 and 130), so it's recreated.
DROP VIEW captures;
CREATE VIEW captures AS SELECT * FROM captures_all WHERE deleted_at IS NULL AND hidden_at IS NULL;

-- Groundwork only, left empty: a species' known forms (a juvenile that looks like another
-- species, a colour morph), so a photo's stage or morph can later link to what's known about it.
CREATE TABLE species_forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  species_id uuid NOT NULL REFERENCES species(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('life_stage', 'morph', 'plumage')),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  description text,
  -- The species this form is often taken for, when it is.
  mistaken_for_species_id uuid REFERENCES species(id) ON DELETE SET NULL,
  UNIQUE (species_id, kind, name)
);
