import { strykerConfig } from "../../stryker.shared.mjs";

export default strykerConfig({
  name: "api",
  mutate: [
    "src/lib/spaFallback.ts",
    "src/auth/rateLimiter.ts",
    "src/auth/password.ts",
    "src/uploads/organizedPath.ts",
    // Its database lookup is checked by speciesFolderName.integration.test.ts in the integration
    // suite, but not under Stryker: as a mutate target in the integration config it pulls in
    // nearly every upload integration test, and that run crashes in a native module.
    "src/uploads/speciesFolderName.ts",
  ],
});
