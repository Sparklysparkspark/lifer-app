import { strykerConfig } from "../../stryker.shared.mjs";

export default strykerConfig({
  name: "data-pipeline",
  mutate: [
    "src/pipeline/gate.ts",
    // Only the pure helpers: fetchWithHardTimeout and inatPlaceQueryNames. The rest of the file is
    // iNaturalist, database and disk-cache plumbing with no unit tests. Update the lines if they move.
    "src/regions/inatChecklist.ts:35-49",
    "src/regions/inatChecklist.ts:183-187",
  ],
});
