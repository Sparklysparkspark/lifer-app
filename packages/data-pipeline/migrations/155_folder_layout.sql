-- One ordered folder layout replaces the two folder switches (by year, by location). Levels are
-- listed outermost first (packages/shared/src/folderLayout.ts). Each account keeps the layout it
-- had: both switches together were <place>/Wildlife <year>/<group>/<species>, and the place
-- folder now sits under its country and province.
ALTER TABLE users ADD COLUMN folder_layout text[] NOT NULL DEFAULT '{group,species}';
UPDATE users SET folder_layout = CASE
  WHEN organize_originals_by_location AND organize_originals_by_year
    THEN '{country,province,place,wildlifeYear,group,species}'::text[]
  WHEN organize_originals_by_location THEN '{country,province,place,group,species}'::text[]
  WHEN organize_originals_by_year THEN '{wildlifeYear,group,species}'::text[]
  ELSE '{group,species}'::text[]
END;
ALTER TABLE users DROP COLUMN organize_originals_by_year, DROP COLUMN organize_originals_by_location;
