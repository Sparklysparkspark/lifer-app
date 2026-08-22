-- Raw local record count treats a single-bird vagrant event chased/photographed by dozens of
-- birders over a short window (e.g. Costa's Hummingbird in BC, September 2024) identically to
-- genuine steady presence, which reads as "uncommon" rather than what it actually was.
-- Informational flag, same philosophy as species_traits.extinct_in_wild — never excludes a
-- species from a region's checklist, just explains why its local_tier reads rarer than raw
-- count alone would suggest.
ALTER TABLE region_species ADD COLUMN is_vagrant boolean NOT NULL DEFAULT false;
