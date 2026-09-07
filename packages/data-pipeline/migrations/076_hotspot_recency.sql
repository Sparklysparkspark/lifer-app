-- A hotspot cluster previously carried no time dimension at all — a cluster built from records
-- spanning last year and one built entirely from a single sighting years ago rendered
-- identically. Real facts (not a derived confidence score) so the user can judge reliability
-- themselves, the same way eBird shows "last reported" rather than inventing a score.
ALTER TABLE region_species_hotspots ADD COLUMN last_seen_year int;
ALTER TABLE region_species_hotspots ADD COLUMN distinct_years int;
