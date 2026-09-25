-- Reference photo URLs that must never be used: range maps, spectrograms, charts and similar
-- non-photos that Wikipedia's media lists mixed into species galleries (found by
-- apps/api/src/scripts/flag-non-photo-reference-images.ts, then reviewed by hand).
--
-- Catalog data like every other catalog table: shipped in the catalog seed, so a catalog update
-- deletes these photos from installs that already have them (catalog merges only ever add or
-- update rows, so removing a photo from the maintainer database alone never reached them), and
-- pack installs and live enrichment skip them.
CREATE TABLE reference_photo_blocklist (
  photo_url text PRIMARY KEY,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
