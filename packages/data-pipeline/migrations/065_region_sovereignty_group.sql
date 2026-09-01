-- Natural Earth's SOV_A3 sovereignty-group code, country-level only (null for World/continents
-- and for admin-1 provinces) — shared by a country and its own geographically-distant
-- territories (USA and Puerto Rico both carry "US1", France and New Caledonia both carry
-- "FR1"), even though Natural Earth already places each one under its own TRUE geographic
-- continent rather than nesting territories under the metropolitan country the way admin-1
-- provinces are nested. Lets the UI show "United States of America"'s territories (Puerto
-- Rico, U.S. Virgin Is., U.S. Minor Outlying Is.) as a grouped panel without needing a second,
-- hand-curated continent mapping.
ALTER TABLE regions ADD COLUMN sovereignty_group text NULL;
