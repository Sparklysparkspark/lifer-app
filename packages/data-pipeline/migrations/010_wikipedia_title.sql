-- Stores the species' English Wikipedia article title (from Wikidata's sitelink, already
-- resolved during the pipeline) so the API can fetch its reference-photo gallery lazily —
-- on first view of a species detail page — instead of eagerly for all ~11,000 species
-- upfront: the eager full-backbone gallery fetch alone would run an estimated 10+ hours, for
-- species that may never be looked at. Eager per-species fetching is still available as a
-- manual follow-up run later; this doesn't remove that option.
ALTER TABLE species ADD COLUMN wikipedia_title text NULL;
