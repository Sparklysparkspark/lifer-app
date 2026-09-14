-- Free-text custom tags a photographer assigns per photo (e.g. "flight shot", "courtship
-- display", "first of season") — plain user vocabulary, not a controlled list, so a simple
-- text[] column is enough; no separate tags table to manage/rename/dedupe. A GIN index makes
-- "which captures have this tag" (a future browse-by-tag filter) a real indexed lookup rather
-- than a sequential scan, even though nothing queries it that way yet.
ALTER TABLE captures_all ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
CREATE INDEX idx_captures_all_tags ON captures_all USING GIN (tags);

-- Same "the view has an explicit column list that must be kept in sync" trap migration 094's
-- own comment already called out — CREATE VIEW captures AS SELECT * FROM captures_all doesn't
-- automatically pick up a newly added column on captures_all, since the view was already
-- created with its own frozen `SELECT *` at the time IT ran, not a live one.
DROP VIEW captures;
CREATE VIEW captures AS SELECT * FROM captures_all WHERE deleted_at IS NULL;
