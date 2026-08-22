-- The species detail description was limited to a single truncated sentence and never
-- captured habitat/range info, even though the same Wikipedia article text already fetched
-- usually has a dedicated Habitat/Range/Distribution section — this adds a separate field
-- for it rather than cramming everything into one blob.
ALTER TABLE species ADD COLUMN habitat_description text NULL;
