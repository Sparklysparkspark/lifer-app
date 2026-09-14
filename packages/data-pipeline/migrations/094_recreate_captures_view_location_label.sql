-- Migration 093 added captures_all.location_label but never recreated the `captures` view over
-- it (see migration 067's own comment: a `SELECT *` view freezes its column list at CREATE VIEW
-- time, so this doesn't propagate automatically) — every insert into the view was failing with
-- "column location_label of relation captures does not exist" since 093 shipped.
DROP VIEW captures;
CREATE VIEW captures AS SELECT * FROM captures_all WHERE deleted_at IS NULL;
