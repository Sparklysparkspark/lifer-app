// Publishes build-catalog-seed.ts output to the catalog-latest release (pipeline/catalogPublish.ts).
// Usage: npx tsx packages/data-pipeline/src/scripts/publish-catalog-seed.ts <dir with catalog-manifest.json>
import { publishCatalogSeed } from "../pipeline/catalogPublish.js";

const dir = process.argv[2];
if (!dir) {
  console.error("Usage: publish-catalog-seed.ts <dir>");
  process.exit(1);
}
publishCatalogSeed(dir);
