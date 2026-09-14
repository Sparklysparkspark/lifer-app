-- "target" used to be one value of user_species.state, mutually exclusive with
-- collected/seen — meaning a species you'd already photographed could never also be marked as
-- a target (e.g. to go back for a better shot). Split it into its own independent boolean so
-- it can coexist with any state, or exist on its own with no state at all yet.
ALTER TABLE user_species ADD COLUMN is_target boolean NOT NULL DEFAULT false;
UPDATE user_species SET is_target = true WHERE state = 'target';

ALTER TABLE user_species DROP CONSTRAINT user_species_state_check;
ALTER TABLE user_species ALTER COLUMN state DROP NOT NULL;
UPDATE user_species SET state = NULL WHERE state = 'target';
ALTER TABLE user_species ADD CONSTRAINT user_species_state_check CHECK (state IS NULL OR state IN ('collected', 'seen'));
