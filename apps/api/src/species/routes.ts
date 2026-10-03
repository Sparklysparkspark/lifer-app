import type { FastifyInstance } from "fastify";
import { speciesSearchRoutes } from "./search.js";
import { speciesDetailRoutes } from "./detail.js";
import { referencePhotoRoutes } from "./referencePhotos.js";
import { otherTaxaRoutes } from "./otherTaxa.js";

export async function speciesRoutes(app: FastifyInstance): Promise<void> {
  await speciesSearchRoutes(app);
  await speciesDetailRoutes(app);
  await referencePhotoRoutes(app);
  await otherTaxaRoutes(app);
}
