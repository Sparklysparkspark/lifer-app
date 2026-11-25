-- The API key that imported a capture, so a connected app may add species only to photos it brought
-- in (POST /captures/:id/species). NULL for every other import, including all photos from before.
-- Left out of the `captures` view on purpose: only the provenance check reads it, from captures_all.
ALTER TABLE captures_all ADD COLUMN imported_by_key_id uuid REFERENCES api_keys(id) ON DELETE SET NULL;
