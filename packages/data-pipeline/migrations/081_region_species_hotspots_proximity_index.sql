-- The Near Me feature (apps/api/src/nearMe/routes.ts) queries region_species_hotspots by a
-- lat/lon bounding box around the user's own location before computing real distance in JS —
-- the existing (region_id, species_id) index doesn't help that lookup at all.
CREATE INDEX region_species_hotspots_centroid_idx ON region_species_hotspots (centroid_lat, centroid_lon);
