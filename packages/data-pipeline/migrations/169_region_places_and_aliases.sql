-- Region search and placeholders (D-03, D-04): an example city per region, the most populous
-- direct child, and other names a region is known by ("Holland", "Britain", "Burma"). The
-- pipeline's places and aliases steps fill them; installs get them with the next catalog update.
-- populous_child_id has no foreign key, like home_country_id: a catalog update inserts regions in
-- any order. The parent and home-country indexes serve the tree walks that search and the browser do.
ALTER TABLE regions ADD COLUMN example_city text;
ALTER TABLE regions ADD COLUMN populous_child_id uuid;
ALTER TABLE regions ADD COLUMN aliases text[] NOT NULL DEFAULT '{}';

CREATE INDEX regions_parent_idx ON regions (parent_id);
CREATE INDEX regions_home_country_idx ON regions (home_country_id) WHERE home_country_id IS NOT NULL;
