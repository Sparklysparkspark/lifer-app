-- Target/wishlist list: a species you want to find someday, distinct from collected/seen.
-- Reuses user_species.state (rather than a new table) so every existing per-user-species query
-- path (archive exclusion, collection counts, pack-unlock gating) already knows how to join
-- against it — see apps/api/src/species/obscurity.ts's ALREADY_OWNED_SQL, deliberately scoped
-- to keep 'target' out of that "already owned" bypass.
ALTER TABLE user_species DROP CONSTRAINT user_species_state_check;
ALTER TABLE user_species ADD CONSTRAINT user_species_state_check CHECK (state IN ('collected', 'seen', 'target'));
