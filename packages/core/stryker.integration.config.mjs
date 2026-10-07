import { strykerConfig } from "../../stryker.shared.mjs";

export default strykerConfig({
  name: "core-integration",
  integration: true,
  mutate: ["src/species/speciesMerges.ts"],
});
