-- Short field-guide notes summarised from each species' Wikipedia article, shown on the species
-- page in place of the long Wikipedia text. Written offline by a small model, every bullet checked
-- against the article sentences it cites, and loaded by load-species-notes.ts.
--   habitat_notes         where and how the species lives (Habitat, Feeding, breeding, ...); shown
--                         instead of habitat_description
--   identification_notes  what it looks like (an Identification or Overview heading); shown instead
--                         of description, which stays as the fallback and keeps its CC BY-SA credit
-- Both hold {"sections": [{"heading": text, "bullets": [text]}], "source_url": text,
-- "revision_id": bigint}: source_url is the article the notes were summarised from (the credit
-- link), revision_id the article revision they were written from.
ALTER TABLE species ADD COLUMN IF NOT EXISTS habitat_notes jsonb NULL;
ALTER TABLE species ADD COLUMN IF NOT EXISTS identification_notes jsonb NULL;
