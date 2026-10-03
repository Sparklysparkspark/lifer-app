import type { FastifyInstance } from "fastify";
import { inspectUploadRoutes } from "./inspect.js";
import { rawUploadRoutes } from "./raw.js";
import { photoUploadRoutes } from "./photo.js";
import { videoUploadRoutes } from "./video.js";
import { tusUploadRoutes } from "./tus.js";

// Re-exported for captures/routes.ts and library/reimport.ts.
export { moveManagedOriginalToSpeciesFolder } from "./common.js";

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  await inspectUploadRoutes(app);
  await rawUploadRoutes(app);
  await photoUploadRoutes(app);
  await videoUploadRoutes(app);
  await tusUploadRoutes(app);
}
