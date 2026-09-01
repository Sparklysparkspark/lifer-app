-- Country-level only — true when this entry is a dependency/territory of another country
-- rather than the primary sovereign state itself (Natural Earth's SOVEREIGNT property equals
-- NAME for the primary entry, e.g. France, and differs for its own territories, e.g. New
-- Caledonia/SOVEREIGNT=France). Lets the picker keep its main continent pill list to just
-- primary countries, moving territories into a separate "Other Territories" catch-all per
-- continent instead of cluttering the main list.
ALTER TABLE regions ADD COLUMN is_sovereign_dependency boolean NOT NULL DEFAULT false;
