-- species_naming_styles used to be "extra codes on top of an always-shown common name" — a
-- stored ["aba_code"] meant "Mallard (MALL)", common name implied. Now that "common"/"latin" are
-- real, explicit, orderable parts of the same array (composeSpeciesName no longer assumes an
-- implicit common-name base), any row that predates this and has no "common"/"latin" entry needs
-- it prepended so existing users' settings keep meaning exactly what they already configured.
UPDATE users
SET species_naming_styles = array_prepend('common', species_naming_styles)
WHERE array_length(species_naming_styles, 1) > 0
  AND NOT ('common' = ANY(species_naming_styles) OR 'latin' = ANY(species_naming_styles));
