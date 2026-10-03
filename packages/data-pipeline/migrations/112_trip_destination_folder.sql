-- A trip now has two folders: source_folder, the user's own trip folder that Lifer only ever
-- reads (a scan offers the wildlife in it), and destination_folder, where Lifer files a sorted
-- copy of each imported photo (<destination>/Birds/<species>/Adjusted, with its RAW) and which
-- it manages from then on: relinking, the recovery index and RAW linking all work there.
-- Chosen by the user; the app suggests <source_folder>/Wildlife.
ALTER TABLE trips ADD COLUMN destination_folder TEXT;
UPDATE trips SET destination_folder = source_folder || '/Wildlife' WHERE destination_folder IS NULL;
ALTER TABLE trips ALTER COLUMN destination_folder SET NOT NULL;
