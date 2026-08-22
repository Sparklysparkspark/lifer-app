-- A photography life-list app has no use for a species nobody can ever photograph. Distinct
-- from extinct_in_wild (informational only — per the Spix's Macaw precedent, extinct in the
-- wild but a real captive/reintroduction population still exists, so it's still a legitimate
-- target). fully_extinct means no living individual exists anywhere, wild OR captive —
-- verified against GBIF: zero records of ANY kind (including LIVING_SPECIMEN, which would
-- catch a captive population) across the species' entire history. These are hidden from
-- collection/region listings entirely by default.
ALTER TABLE species_traits ADD COLUMN fully_extinct boolean NOT NULL DEFAULT false;
