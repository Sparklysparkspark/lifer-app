import { strykerConfig } from "../../stryker.shared.mjs";

export default strykerConfig({
  name: "data-pipeline-integration",
  integration: true,
  mutate: ["src/pipeline/photoLicensePolicy.ts"],
});
