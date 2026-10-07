import { strykerConfig } from "../../stryker.shared.mjs";

export default strykerConfig({
  name: "core",
  mutate: [
    "src/lib/allowedPaths.ts",
    "src/lib/pathContainment.ts",
    "src/lib/safeFs.ts",
    "src/lib/requestGuard.ts",
    "src/lib/geometry.ts",
    "src/lib/concurrency.ts",
    "src/uploads/formats.ts",
    "src/species/licensePolicy.ts",
    // Only the pure helpers: fetchWithHardTimeout and inatPlaceQueryNames. The rest of the file is
    // iNaturalist, database and disk-cache plumbing with no unit tests. Update the lines if they move.
    "src/regions/inatChecklist.ts:23-37",
    "src/regions/inatChecklist.ts:171-175",
  ],
});
