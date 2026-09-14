-- "Any taxa" search (Settings > Species & Import): lets a user pull in a species Lifer has no
-- real dataset coverage for (insects, arachnids, plants, fungi, ...) straight from iNaturalist,
-- by name, and drop it onto one region's checklist. These are deliberately NOT run through the
-- rarity/occurrence pipeline the rest of the catalog gets (region_species.local_tier/
-- local_frequency/weekly_frequency stay NULL for them) — with tens of thousands of insect
-- species alone, world-scale rarity tiering was never meant to cover this tier of taxon.
-- taxon_class stays NOT NULL even for these rows (it's set to iNaturalist's own lowercased
-- iconic-taxon name, e.g. "insecta" — never a real value from the app's fixed TaxonClass union,
-- deliberately: every existing taxon_class-driven query (rarity thresholds, the 18-group
-- filters/labels) only ever matches against that fixed set, so an other-taxa row's taxon_class
-- naturally falls through all of them untouched rather than needing every one of those call
-- sites updated to also check is_other_taxa). is_other_taxa is the actual, explicit gate the
-- NEW "Other Taxa" code path checks.
ALTER TABLE species ADD COLUMN IF NOT EXISTS is_other_taxa boolean NOT NULL DEFAULT false;
-- iNaturalist's own coarse grouping, human-readable (e.g. "Insects", "Arachnids", "Plants",
-- "Fungi") — the display label for the "Other Taxa" bucket's own sub-groupings on the
-- Collection page.
ALTER TABLE species ADD COLUMN IF NOT EXISTS inat_iconic_taxon text NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS any_taxa_search_enabled boolean NOT NULL DEFAULT false;
