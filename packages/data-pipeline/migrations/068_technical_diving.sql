-- Hide Obscure's own depth cutoff (species_traits.depth_min_m) was a flat 120m — technical
-- diving's own realistic limit — but most photographers are recreational divers, whose
-- practical range tops out closer to 50-60m (open-water/advanced certs, no trimix). A fish
-- whose shallowest known record is 80m is "unreachable" for nearly everyone even though it's
-- inside the old 120m cutoff. Same on/off, default-true-hides pattern as migration 038's own
-- hide_obscure_species — false is the recreational default (60m cutoff), true opts into the
-- wider 120m technical-diving range.
ALTER TABLE users ADD COLUMN technical_diving boolean NOT NULL DEFAULT false;
