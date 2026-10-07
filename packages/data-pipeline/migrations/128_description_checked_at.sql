-- Text state, separate from enriched_at (which only ever meant "a photo lookup ran"). A species
-- could be stamped enriched_at by a path that never read any text (a throttled iNaturalist taxon
-- request, an offline pack's photos, the photo store), and nothing looked for its description
-- again.
--   description_checked_at  when a text source (iNaturalist's taxon record or the Wikipedia
--                           article) was last actually read for the species, found or not.
--   wikipedia_revision_id   the revision (lastrevid) of the Wikipedia article the species' text
--                           came from. Per species, not per field: a habitat extract from the
--                           same article shares it. backfill-descriptions.ts --refresh refetches
--                           only articles whose revision changed.
--   wikipedia_checked_at    when backfill-descriptions.ts last looked the article up, found or not.
ALTER TABLE species ADD COLUMN IF NOT EXISTS description_checked_at timestamptz NULL;
ALTER TABLE species ADD COLUMN IF NOT EXISTS wikipedia_revision_id bigint NULL;
ALTER TABLE species ADD COLUMN IF NOT EXISTS wikipedia_checked_at timestamptz NULL;

-- A species with a description was evidently checked when it was enriched.
UPDATE species SET description_checked_at = enriched_at
WHERE description IS NOT NULL AND enriched_at IS NOT NULL AND description_checked_at IS NULL;
