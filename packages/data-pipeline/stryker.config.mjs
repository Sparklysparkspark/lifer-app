import { strykerConfig } from "../../stryker.shared.mjs";

export default strykerConfig({
  name: "data-pipeline",
  mutate: ["src/pipeline/gate.ts"],
});
