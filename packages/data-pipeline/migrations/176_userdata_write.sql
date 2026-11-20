-- Companion apps' writes (userdata.write, apps/api/src/userdata/writeRoutes.ts) go into the change
-- log with the app's name, so Settings > Connected apps can list and undo them. Assistant changes
-- keep app_name NULL.
ALTER TABLE change_batches ADD COLUMN app_name text;

-- "Needs a better photo": a mark the user or a companion app sets on a species, shown on the
-- species page and as a Collection filter. Syncs with the other species marks.
ALTER TABLE user_species ADD COLUMN needs_better_photo boolean NOT NULL DEFAULT false;
