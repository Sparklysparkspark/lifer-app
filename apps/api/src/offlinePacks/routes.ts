// Offline packs: region and sea-zone checklists with reference photos, built by data-pipeline's
// build-region-pack.ts. The listing, download and removal routes live in their own modules.
import type { FastifyInstance } from "fastify";
import { packIndexRoutes } from "./index.js";
import { packDownloadRoutes } from "./download.js";
import { packRemoveRoutes } from "./remove.js";

export { fetchPackIndex, type PackIndex, type PackIndexEntry } from "./index.js";

export async function offlinePacksRoutes(app: FastifyInstance): Promise<void> {
  await app.register(packIndexRoutes);
  await app.register(packDownloadRoutes);
  await app.register(packRemoveRoutes);
}
