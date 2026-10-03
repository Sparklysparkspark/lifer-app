import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireScope } from "../auth/session.js";
import { cosineSimilarity } from "../species/embeddings.js";
import { embedQueryText } from "../species/textEmbedding.js";
import { EMBEDDING_MODEL_VERSION } from "../config.js";
import { parseShutterSeconds } from "./shutter.js";

// Deeper stats views: species portfolio, library health, gear usage, year over year, and the
// "photography DNA" profile.
export async function statsInsightRoutes(app: FastifyInstance): Promise<void> {
  // Per-species photo counts behind the leaderboard, one-and-done species, rating prompts and the
  // portfolio table. Every confirmed photo counts here, not only keepers.
  app.get("/stats/species-portfolio", { preHandler: requireScope("stats.read") }, async (request) => {
    const userId = request.user!.id;
    const res = await pool.query<{
      species_id: string;
      common_name: string | null;
      scientific_name: string;
      taxon_class: string;
      total_photos: number;
      rated_4_plus: number;
      best_rating: number | null;
      earliest_taken_at: string | null;
      latest_taken_at: string | null;
    }>(
      `SELECT s.id AS species_id, s.common_name, s.scientific_name, s.taxon_class,
              COUNT(*)::int AS total_photos,
              COUNT(*) FILTER (WHERE c.quality_rating >= 4)::int AS rated_4_plus,
              MAX(c.quality_rating) AS best_rating,
              MIN(c.taken_at)::text AS earliest_taken_at,
              MAX(c.taken_at)::text AS latest_taken_at
       FROM captures c
       JOIN species s ON s.id = c.species_id
       WHERE c.user_id = $1
       GROUP BY s.id, s.common_name, s.scientific_name, s.taxon_class`,
      [userId],
    );
    return {
      species: res.rows.map((r) => ({
        speciesId: r.species_id,
        commonName: r.common_name,
        scientificName: r.scientific_name,
        taxonClass: r.taxon_class,
        totalPhotos: r.total_photos,
        rated4Plus: r.rated_4_plus,
        bestRating: r.best_rating,
        earliestTakenAt: r.earliest_taken_at,
        latestTakenAt: r.latest_taken_at,
      })),
    };
  });

  // Library health: how much is missing data a normal photo would have. Ratings, GPS and
  // one-photo species aren't counted, since none of them is a problem to fix.
  app.get("/stats/archive-health", { preHandler: requireScope("stats.read") }, async (request) => {
    const userId = request.user!.id;
    const res = await pool.query<{
      total: number;
      missing_date: number;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM captures WHERE user_id = $1)::int AS total,
         (SELECT COUNT(*) FROM captures WHERE user_id = $1 AND taken_at IS NULL)::int AS missing_date`,
      [userId],
    );
    const row = res.rows[0];
    return {
      total: row.total,
      missingDate: row.missing_date,
    };
  });

  // Taxon breakdown of photos taken with a camera, a lens, or both.
  app.get<{ Querystring: { camera?: string; lens?: string } }>(
    "/stats/gear-species-breakdown",
    { preHandler: requireScope("stats.read") },
    async (request) => {
      const userId = request.user!.id;
      const { camera, lens } = request.query;
      if (!camera && !lens) return { breakdown: [] };
      const conditions = ["c.user_id = $1"];
      const params: unknown[] = [userId];
      if (camera) {
        params.push(camera);
        conditions.push(`c.camera_model = $${params.length}`);
      }
      if (lens) {
        params.push(lens);
        conditions.push(`c.lens = $${params.length}`);
      }
      const res = await pool.query<{ taxon_class: string; count: number }>(
        `SELECT s.taxon_class, COUNT(*)::int AS count
         FROM captures c JOIN species s ON s.id = c.species_id
         WHERE ${conditions.join(" AND ")}
         GROUP BY s.taxon_class ORDER BY count DESC`,
        params,
      );
      const total = res.rows.reduce((sum, r) => sum + r.count, 0);
      return {
        breakdown: res.rows.map((r) => ({
          taxonClass: r.taxon_class,
          count: r.count,
          percent: total > 0 ? Math.round((r.count / total) * 1000) / 10 : 0,
        })),
      };
    },
  );

  // Year over year: the library-wide numbers computed for each year side by side. Plain EXIF and
  // count aggregates only, so it stays fast over a whole year.
  app.get<{ Querystring: { yearA: string; yearB: string } }>(
    "/stats/year-comparison",
    { preHandler: requireScope("stats.read") },
    async (request, reply) => {
      const userId = request.user!.id;
      const yearA = Number(request.query.yearA);
      const yearB = Number(request.query.yearB);
      if (!Number.isInteger(yearA) || !Number.isInteger(yearB)) {
        return reply.code(400).send({ error: "yearA and yearB must both be integers" });
      }

      async function statsForYear(year: number) {
        const res = await pool.query<{
          species_count: number;
          photo_count: number;
          avg_focal_length: number | null;
          avg_iso: number | null;
        }>(
          `SELECT
             COUNT(DISTINCT species_id)::int AS species_count,
             COUNT(*)::int AS photo_count,
             AVG(focal_length_mm) AS avg_focal_length,
             AVG(iso) AS avg_iso
           FROM captures
           WHERE user_id = $1 AND EXTRACT(YEAR FROM taken_at) = $2`,
          [userId, year],
        );
        const row = res.rows[0];
        return {
          year,
          speciesCount: row.species_count,
          photoCount: row.photo_count,
          avgFocalLength: row.avg_focal_length != null ? Math.round(Number(row.avg_focal_length)) : null,
          avgIso: row.avg_iso != null ? Math.round(Number(row.avg_iso)) : null,
        };
      }

      const [a, b] = await Promise.all([statsForYear(yearA), statsForYear(yearB)]);
      return { a, b };
    },
  );

  // "Photography DNA": the taxa someone shoots, the kind of shot (portrait, flight, behavior,
  // habitat, by the same CLIP matching as best-by-category), and median focal length, shutter and
  // ISO (medians, so one outlier doesn't skew them).
  app.get("/stats/photography-dna", { preHandler: requireScope("stats.read") }, async (request) => {
    const userId = request.user!.id;

    const taxonRes = await pool.query<{ taxon_class: string; count: number }>(
      `SELECT s.taxon_class, COUNT(*)::int AS count
       FROM captures c JOIN species s ON s.id = c.species_id
       WHERE c.user_id = $1 GROUP BY s.taxon_class ORDER BY count DESC`,
      [userId],
    );
    const taxonTotal = taxonRes.rows.reduce((sum, r) => sum + r.count, 0);

    const exifRes = await pool.query<{ focal_length_mm: string | null; shutter: string | null; iso: number | null }>(
      `SELECT focal_length_mm, shutter, iso FROM captures WHERE user_id = $1`,
      [userId],
    );
    function median(values: number[]): number | null {
      if (values.length === 0) return null;
      const sorted = [...values].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    }
    const focalLengths = exifRes.rows.map((r) => (r.focal_length_mm != null ? Number(r.focal_length_mm) : null)).filter((v): v is number => v != null);
    const shutters = exifRes.rows.map((r) => (r.shutter != null ? parseShutterSeconds(r.shutter) : null)).filter((v): v is number => v != null);
    const isos = exifRes.rows.map((r) => r.iso).filter((v): v is number => v != null);

    const embeddingsRes = await pool.query<{ embedding: number[] }>(
      `SELECT ce.embedding FROM capture_embeddings ce
       JOIN captures c ON c.id = ce.capture_id
       WHERE c.user_id = $1 AND ce.model_version = $2`,
      [userId, EMBEDDING_MODEL_VERSION],
    );

    const categories: Array<{ key: string; prompt: string }> = [
      { key: "portrait", prompt: "a close-up portrait photo of a wild animal" },
      { key: "flight", prompt: "a photo of a bird in flight" },
      { key: "behavior", prompt: "a wild animal feeding, hunting, or interacting" },
      { key: "environmental", prompt: "a wide environmental photo of an animal in its habitat" },
    ];
    const categoryCounts: Record<string, number> = Object.fromEntries(categories.map((c) => [c.key, 0]));
    if (embeddingsRes.rows.length > 0) {
      const promptEmbeddings = await Promise.all(categories.map((c) => embedQueryText(c.prompt)));
      for (const row of embeddingsRes.rows) {
        let bestKey = categories[0].key;
        let bestScore = -Infinity;
        categories.forEach((c, idx) => {
          const score = cosineSimilarity(promptEmbeddings[idx], row.embedding);
          if (score > bestScore) {
            bestScore = score;
            bestKey = c.key;
          }
        });
        categoryCounts[bestKey]++;
      }
    }
    const categoryTotal = embeddingsRes.rows.length;

    return {
      taxonBreakdown: taxonRes.rows.map((r) => ({
        taxonClass: r.taxon_class,
        count: r.count,
        percent: taxonTotal > 0 ? Math.round((r.count / taxonTotal) * 1000) / 10 : 0,
      })),
      categoryBreakdown: categories.map((c) => ({
        key: c.key,
        count: categoryCounts[c.key],
        percent: categoryTotal > 0 ? Math.round((categoryCounts[c.key] / categoryTotal) * 1000) / 10 : 0,
      })),
      medianFocalLengthMm: median(focalLengths),
      medianShutterSeconds: median(shutters),
      medianIso: median(isos),
    };
  });
}
