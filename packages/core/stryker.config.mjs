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
  ],
});
