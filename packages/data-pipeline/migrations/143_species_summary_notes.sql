-- A short field-guide paragraph summarised from each species' Wikipedia article, in the style of
-- eBird's species descriptions, shown on the species page in place of the identification and
-- habitat notes (migration 140). Written offline by a small model one sentence at a time, each
-- sentence checked against the article sentences it cites, and loaded by load-species-notes.ts.
-- Same shape as those notes, with one "Summary" section whose bullets are the paragraph's
-- sentences in reading order: {"sections": [...], "source_url": text, "revision_id": bigint}.
ALTER TABLE species ADD COLUMN IF NOT EXISTS summary_notes jsonb NULL;
