-- Soft-delete for captures ("Delete Photo" -> a week in Trash -> permanent removal), done as a
-- renamed base table + a same-named updatable view rather than a `deleted_at IS NULL` clause
-- added to every query, because 17 different files across this codebase query `captures` —
-- adding the filter to all of them by hand is exactly the kind of change one missed call site
-- turns into a silently-resurrected "deleted" photo somewhere unexpected. Postgres auto-updates
-- a single-table view like this one for INSERT/UPDATE/DELETE (SQL-standard "simply updatable
-- view"), so every existing INSERT/UPDATE/DELETE/SELECT against `captures` keeps working
-- completely unchanged and automatically stops seeing trashed rows — only the new trash-specific
-- code (trash/restore/purge, the Trashed Photos page) needs to reach past the view to
-- `captures_all` directly. Foreign keys referencing captures(id) (photos, originals,
-- capture_embeddings, capture_species) survive the rename untouched — Postgres FKs bind to the
-- table by OID, not by name.
ALTER TABLE captures RENAME TO captures_all;

ALTER TABLE captures_all ADD COLUMN deleted_at timestamptz NULL;
-- Recorded at trash time (the "also delete matching RAW" checkbox), acted on only once the
-- purge job actually removes the capture for good — trashing itself never touches any file on
-- disk, so restoring within the week is always a pure DB no-op with nothing to recover from disk.
ALTER TABLE captures_all ADD COLUMN pending_delete_raw boolean NOT NULL DEFAULT false;

CREATE VIEW captures AS SELECT * FROM captures_all WHERE deleted_at IS NULL;
