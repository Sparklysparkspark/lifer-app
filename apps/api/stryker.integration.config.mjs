import { strykerConfig } from "../../stryker.shared.mjs";

export default strykerConfig({
  name: "api-integration",
  integration: true,
  mutate: ["src/settings/storageMove.ts", "src/offlinePacks/apply.ts", "src/captures/routes.ts"],
});
