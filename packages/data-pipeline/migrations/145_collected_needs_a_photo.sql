-- A species counts as collected only while it has a photo you can see: one in the Trash doesn't
-- count (api/lib/userSpecies.ts syncCollectedState keeps it so from now on). Corrects species left
-- collected with no photos: deleting the last one used to leave the state as it was, and emptying
-- the Trash then skipped the species, whose featured photo had already been cleared.
UPDATE user_species us
   SET state = NULL
 WHERE us.state = 'collected'
   AND NOT EXISTS (SELECT 1 FROM captures c WHERE c.user_id = us.user_id AND c.species_id = us.species_id)
   AND NOT EXISTS (
     SELECT 1 FROM capture_species cs JOIN captures c ON c.id = cs.capture_id
      WHERE cs.species_id = us.species_id AND c.user_id = us.user_id
   );
