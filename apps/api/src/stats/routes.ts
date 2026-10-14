import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { requireScope } from "../auth/session.js";
import { replies, withSchemas } from "../lib/schema.js";
import { getObscurityPreferences } from "../species/obscurity.js";
import { statsInsightRoutes } from "./insights.js";
import { KEEPER_FILTER, loadStatsOverview, photoFilterFragment, type PhotoFilter } from "./overview.js";
import { StatsOverview } from "./responses.js";

const FilterQuery = Type.Object({
  filter: Type.Optional(
    Type.Enum(["all", "featured", "topRated"], {
      description: "all (default), featured (species cover photos) or topRated (5 stars)",
    }),
  ),
});

export async function statsRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  const filtered = { preValidation: requireScope("stats.read"), schema: { querystring: FilterQuery } };

  app.get(
    "/stats",
    { ...filtered, schema: { ...filtered.schema, response: replies(StatsOverview) } },
    async (request) => {
      const userId = request.user!.id;
      const { maxDepthM } = await getObscurityPreferences(userId);
      // One pooled client, so a page load doesn't take a pool slot per query.
      const client = await pool.connect();
      try {
        return await loadStatsOverview(client, userId, request.query.filter ?? "all", maxDepthM);
      } finally {
        client.release();
      }
    },
  );

  function csvField(value: string | number | null | undefined): string {
    if (value == null) return "";
    const s = String(value);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  // One row per keeper capture with raw EXIF/species fields, for charting elsewhere.
  app.get("/stats/export.csv", filtered, async (request, reply) => {
    const userId = request.user!.id;
    const filter: PhotoFilter = request.query.filter ?? "all";
    const scope = `${KEEPER_FILTER} ${photoFilterFragment(filter)}`;

    const res = await pool.query<{
      scientific_name: string;
      common_name: string | null;
      taken_at: string | null;
      camera_model: string | null;
      lens: string | null;
      focal_length_mm: string | null;
      aperture: string | null;
      shutter: string | null;
      iso: number | null;
      quality_rating: number | null;
      country_name: string | null;
    }>(
      `SELECT s.scientific_name, s.common_name, c.taken_at, c.camera_model, c.lens, c.focal_length_mm, c.aperture, c.shutter, c.iso,
              c.quality_rating,
              (SELECT country.name FROM regions leaf
                 LEFT JOIN regions up1 ON up1.id = COALESCE(leaf.home_country_id, leaf.parent_id)
                 JOIN regions country ON country.id = (CASE WHEN leaf.external_codes[1] ~ '^[A-Z]{3}$' THEN leaf.id
                                                            WHEN up1.external_codes[1] ~ '^[A-Z]{3}$' THEN up1.id
                                                            ELSE up1.parent_id END)
               WHERE leaf.id = c.region_id AND country.external_codes[1] ~ '^[A-Z]{3}$') AS country_name
       FROM captures c
       JOIN species s ON s.id = c.species_id
       WHERE c.user_id = $1 AND ${scope}
       ORDER BY c.taken_at ASC NULLS LAST`,
      [userId],
    );

    const header = [
      "scientific_name",
      "common_name",
      "taken_at",
      "camera_model",
      "lens",
      "focal_length_mm",
      "aperture",
      "shutter",
      "iso",
      "quality_rating",
      "country",
    ];
    const lines = [header.join(",")];
    for (const r of res.rows) {
      lines.push(
        [
          csvField(r.scientific_name),
          csvField(r.common_name),
          csvField(r.taken_at),
          csvField(r.camera_model),
          csvField(r.lens),
          csvField(r.focal_length_mm),
          csvField(r.aperture),
          csvField(r.shutter),
          csvField(r.iso),
          csvField(r.quality_rating),
          csvField(r.country_name),
        ].join(","),
      );
    }

    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="lifer-stats-${filter}.csv"`);
    return lines.join("\n");
  });

  await app.register(statsInsightRoutes);
}
