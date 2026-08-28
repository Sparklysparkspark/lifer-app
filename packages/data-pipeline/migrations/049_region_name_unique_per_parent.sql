-- regions.name was globally unique (migration 004), which worked fine while every region name
-- happened to be a real, distinct place name — but vernacular-region grouping (see
-- apply-vernacular-regions.ts) legitimately reuses names like "Central" or "Northern" across
-- many unrelated countries (Thailand's "Central" region, Uganda's "Central" region, El
-- Salvador's "Central" zone are all real, correct, unrelated places). A region name only ever
-- needs to be unique among its own siblings (children of the same parent), never across the
-- whole world.
ALTER TABLE regions DROP CONSTRAINT regions_name_key;
ALTER TABLE regions ADD CONSTRAINT regions_name_parent_id_key UNIQUE (name, parent_id);
