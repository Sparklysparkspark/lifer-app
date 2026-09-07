-- species_naming_style (migration 077) was a single mutually-exclusive choice (common_name /
-- ebird_code / aba_code), but a user reasonably wants both a code AND the common name together
-- (e.g. folder "Mallard (MALL)") rather than picking one or the other. Common name is always
-- the base now; this new column holds which code(s), if any, get appended alongside it.
ALTER TABLE users ADD COLUMN species_naming_styles text[] NOT NULL DEFAULT '{}';

UPDATE users SET species_naming_styles = ARRAY[species_naming_style]
  WHERE species_naming_style IN ('ebird_code', 'aba_code');

ALTER TABLE users DROP COLUMN species_naming_style;
