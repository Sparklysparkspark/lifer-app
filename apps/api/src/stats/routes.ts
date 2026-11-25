import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { requireScope } from "../auth/session.js";
import { replies, withSchemas } from "../lib/schema.js";
import { getObscurityPreferences } from "../species/obscurity.js";
import { statsInsightRoutes } from "./insights.js";
import { yearInReviewRoutes } from "./yearInReview.js";
import {
  EXIF_DIMENSION_NAMES,
  keeperFilter,
  loadExifBucketPhotoIds,
  loadStatsOverview,
  loadTimeline,
  monthRangeFragment,
  photoFilterFragment,
  type PhotoFilter,
} from "./overview.js";
import { ExifBucketPhotos, StatsOverview, StatsTimeline } from "./responses.js";
import { sensitiveForKey } from "../companion/privacy.js";

const MonthQuery = (description: string) =>
  Type.Optional(Type.String({ pattern: "^\\d{4}-(0[1-9]|1[0-2])$", description }));

const KeeperQuery = {
  filter: Type.Optional(
    Type.Enum(["all", "featured", "topRated"], {
      description: "all (default), featured (species cover photos) or topRated (5 stars)",
    }),
  ),
  includeRaw: Type.Optional(
    Type.Enum(["0", "1"], { description: "0 to leave out photos whose only original is a RAW (default 1)" }),
  ),
};

const FilterQuery = Type.Object({
  ...KeeperQuery,
  from: MonthQuery("First month counted, YYYY-MM; photos without a date are left out of any range"),
  to: MonthQuery("Last month counted, YYYY-MM"),
});

type Filters = { filter?: PhotoFilter; includeRaw?: "0" | "1"; from?: string; to?: string };
const scopeOf = (q: Filters) =>
  `${keeperFilter(q.includeRaw !== "0")} ${photoFilterFragment(q.filter ?? "all")}${monthRangeFragment(q)}`;

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
        return await loadStatsOverview(
          client,
          userId,
          request.query.filter ?? "all",
          maxDepthM,
          request.query.includeRaw !== "0",
          request.query,
        );
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
    const scope = scopeOf(request.query);

    const res = await pool.query<{
      capture_id: string;
      species_id: string;
      region_id: string | null;
      scientific_name: string;
      common_name: string | null;
      taxon_class: string | null;
      taxon_order: string | null;
      family: string | null;
      ebird_code: string | null;
      aba_code: string | null;
      taken_at: string | null;
      camera_model: string | null;
      lens: string | null;
      focal_length_mm: string | null;
      aperture: string | null;
      shutter: string | null;
      iso: number | null;
      quality_rating: number | null;
      country_name: string | null;
      region_name: string | null;
      location_label: string | null;
      lat: number | null;
      lon: number | null;
      tags: string[] | null;
    }>(
      // taken_at as ISO 8601 text: a Date would print in JavaScript's display format.
      `SELECT c.id AS capture_id, c.species_id, c.region_id, s.scientific_name, s.common_name, s.taxon_class, s.taxon_order, s.family, s.ebird_code, s.aba_code,
              to_json(c.taken_at) #>> '{}' AS taken_at, c.camera_model, c.lens, c.focal_length_mm, c.aperture, c.shutter, c.iso,
              c.quality_rating,
              (SELECT country.name FROM regions leaf
                 LEFT JOIN regions up1 ON up1.id = COALESCE(leaf.home_country_id, leaf.parent_id)
                 JOIN regions country ON country.id = (CASE WHEN leaf.external_codes[1] ~ '^[A-Z]{3}$' THEN leaf.id
                                                            WHEN up1.external_codes[1] ~ '^[A-Z]{3}$' THEN up1.id
                                                            ELSE up1.parent_id END)
               WHERE leaf.id = c.region_id AND country.external_codes[1] ~ '^[A-Z]{3}$') AS country_name,
              r.name AS region_name, c.location_label, c.lat, c.lon, c.tags
       FROM captures c
       LEFT JOIN regions r ON r.id = c.region_id
       JOIN species s ON s.id = c.species_id
       WHERE c.user_id = $1 AND ${scope}
       ORDER BY c.taken_at ASC NULLS LAST`,
      [userId],
    );

    const header = [
      "scientific_name",
      "common_name",
      "class",
      "order",
      "family",
      "ebird_code",
      "aba_code",
      "taken_at",
      "camera_model",
      "lens",
      "focal_length_mm",
      "aperture",
      "shutter",
      "iso",
      "quality_rating",
      "country",
      "region",
      "place",
      "latitude",
      "longitude",
      "tags",
    ];
    const lines = [header.join(",")];
    // A sensitive species' photo comes by region only, as on a share.
    const hidden = await sensitiveForKey(request, res.rows);
    for (const r of res.rows) {
      const hide = !!hidden?.has(r.capture_id);
      lines.push(
        [
          csvField(r.scientific_name),
          csvField(r.common_name),
          csvField(r.taxon_class),
          csvField(r.taxon_order),
          csvField(r.family),
          csvField(r.ebird_code),
          csvField(r.aba_code),
          csvField(r.taken_at),
          csvField(r.camera_model),
          csvField(r.lens),
          csvField(r.focal_length_mm),
          csvField(r.aperture),
          csvField(r.shutter),
          csvField(r.iso),
          csvField(r.quality_rating),
          csvField(r.country_name),
          csvField(r.region_name),
          csvField(hide ? null : r.location_label),
          csvField(hide ? null : r.lat),
          csvField(hide ? null : r.lon),
          csvField(r.tags?.join("; ")),
        ].join(","),
      );
    }

    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="lifer-stats-${filter}.csv"`);
    return lines.join("\n");
  });

  // Every photo behind one EXIF chart bar; the overview only carries a sample per bar.
  app.get(
    "/stats/exif-bucket",
    {
      preValidation: requireScope("stats.read"),
      schema: {
        querystring: Type.Object({
          ...FilterQuery.properties,
          dim: Type.Enum(EXIF_DIMENSION_NAMES, { description: "The EXIF chart" }),
          bucket: Type.Integer({ minimum: 1, maximum: 50, description: "The bar, 1 for the first" }),
        }),
        response: replies(ExifBucketPhotos),
      },
    },
    async (request) => {
      const { dim, bucket } = request.query;
      return { photoIds: await loadExifBucketPhotoIds(pool, request.user!.id, scopeOf(request.query), dim, bucket) };
    },
  );

  // The whole timeline for the Stats page's date brush, so it ignores from and to.
  app.get(
    "/stats/timeline",
    {
      preValidation: requireScope("stats.read"),
      schema: { querystring: Type.Object(KeeperQuery), response: replies(StatsTimeline) },
    },
    async (request) => loadTimeline(pool, request.user!.id, scopeOf(request.query)),
  );

  await app.register(statsInsightRoutes);
  await app.register(yearInReviewRoutes);
}
