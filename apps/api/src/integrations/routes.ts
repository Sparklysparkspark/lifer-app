// Endpoints shaped for integrations (life-list counters, new-lifer bots, portfolio sites,
// scripted imports, library mirrors, backups) rather than for Lifer's own UI: stable field names, paging, and incremental
// sync. Documented in docs/API.md and served as OpenAPI at /api/openapi.json; keep both in step
// with this file (integrationsDocs.test.ts checks every API-key route is documented).
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireScope } from "../auth/session.js";
import { buildOpenApi } from "./openapi.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

// Opaque to callers: "<updated_at>|<capture id>", base64url. updated_at travels as text at the
// database's full microsecond precision: a JS Date keeps only milliseconds, and a cursor rounded
// down sorts before the row it came from, so the next page repeated it.
function encodeCursor(updatedAt: string, id: string): string {
  return Buffer.from(`${updatedAt}|${id}`).toString("base64url");
}
const UPDATED_AT_TEXT = `to_char(c.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
function decodeCursor(cursor: string): { updatedAt: string; id: string } | null {
  const [updatedAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (!updatedAt || !id || Number.isNaN(Date.parse(updatedAt)) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { updatedAt, id };
}

const fileName = (ref: string | null) => (ref ? ref.split(/[\\/]/).pop() ?? null : null);

export async function integrationRoutes(app: FastifyInstance): Promise<void> {
  // Public: describes the API, holds no data.
  const openApi = buildOpenApi();
  app.get("/openapi.json", async () => openApi);

  // Every photo (capture) in the library, oldest change first, for syncing to another tool.
  // Pass back nextCursor until it's null; save the last updatedAt and use it as `since` next time
  // to fetch only what changed. Trashed photos come back with deletedAt set when
  // includeDeleted=1 (so a sync can remove them); photos deleted permanently simply stop appearing.
  app.get<{
    Querystring: { since?: string; cursor?: string; limit?: string; speciesId?: string; includeDeleted?: string };
  }>("/captures", { preHandler: requireScope("photos.read") }, async (request, reply) => {
    const userId = request.user!.id;
    const limit = Math.min(Math.max(Number(request.query.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const params: unknown[] = [userId];
    const where = ["c.user_id = $1"];
    if (request.query.includeDeleted !== "1") where.push("c.deleted_at IS NULL");
    if (request.query.since) {
      if (Number.isNaN(Date.parse(request.query.since))) return reply.code(400).send({ error: "since must be an ISO 8601 date-time" });
      params.push(request.query.since);
      where.push(`c.updated_at > $${params.length}`);
    }
    if (request.query.speciesId) {
      params.push(request.query.speciesId);
      where.push(
        `(c.species_id = $${params.length} OR EXISTS (SELECT 1 FROM capture_species cs WHERE cs.capture_id = c.id AND cs.species_id = $${params.length}))`,
      );
    }
    if (request.query.cursor) {
      const cursor = decodeCursor(request.query.cursor);
      if (!cursor) return reply.code(400).send({ error: "Invalid cursor" });
      params.push(cursor.updatedAt, cursor.id);
      where.push(`(c.updated_at, c.id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(limit + 1);

    const res = await pool.query(
      `SELECT c.id, c.current_photo_id, c.species_id, s.scientific_name, s.common_name, s.taxon_class,
              c.taken_at, c.created_at, ${UPDATED_AT_TEXT} AS updated_at, c.deleted_at, c.lat, c.lon, c.region_id, r.name AS region_name,
              c.location_label, c.camera_model, c.lens, c.focal_length_mm, c.aperture, c.shutter, c.iso,
              c.quality_rating, c.tags, c.trip_id, p.kind AS photo_kind, p.width, p.height,
              oj.ref AS jpeg_ref, oj.file_size AS jpeg_size, oj.content_hash AS jpeg_hash,
              orw.ref AS raw_ref, orw.file_size AS raw_size, orw.content_hash AS raw_hash,
              ov.ref AS video_ref, ov.file_size AS video_size, ov.content_hash AS video_hash,
              (SELECT coalesce(json_agg(json_build_object('speciesId', s2.id, 'scientificName', s2.scientific_name, 'commonName', s2.common_name)), '[]'::json)
                 FROM capture_species cs JOIN species s2 ON s2.id = cs.species_id WHERE cs.capture_id = c.id) AS additional_species
       FROM captures_all c
       JOIN species s ON s.id = c.species_id
       LEFT JOIN regions r ON r.id = c.region_id
       LEFT JOIN photos p ON p.id = c.current_photo_id
       LEFT JOIN originals oj ON oj.capture_id = c.id AND oj.kind = 'jpeg'
       LEFT JOIN originals orw ON orw.capture_id = c.id AND orw.kind = 'raw'
       LEFT JOIN originals ov ON ov.capture_id = c.id AND ov.kind = 'video'
       WHERE ${where.join(" AND ")}
       ORDER BY c.updated_at, c.id
       LIMIT $${params.length}`,
      params,
    );
    const rows = res.rows.slice(0, limit);
    const last = rows[rows.length - 1];
    const original = (ref: string | null, size: string | number | null, hash: string | null) =>
      ref ? { fileName: fileName(ref), sizeBytes: size != null ? Number(size) : null, sha256: hash } : null;

    return {
      items: rows.map((r) => ({
        captureId: r.id,
        photoId: r.current_photo_id,
        speciesId: r.species_id,
        scientificName: r.scientific_name,
        commonName: r.common_name,
        taxonClass: r.taxon_class,
        additionalSpecies: r.additional_species,
        takenAt: r.taken_at,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        deletedAt: r.deleted_at,
        lat: r.lat != null ? Number(r.lat) : null,
        lon: r.lon != null ? Number(r.lon) : null,
        regionId: r.region_id,
        regionName: r.region_name,
        locationLabel: r.location_label,
        tripId: r.trip_id,
        camera: {
          model: r.camera_model,
          lens: r.lens,
          focalLengthMm: r.focal_length_mm != null ? Number(r.focal_length_mm) : null,
          aperture: r.aperture != null ? Number(r.aperture) : null,
          shutter: r.shutter,
          iso: r.iso,
        },
        rating: r.quality_rating,
        tags: r.tags ?? [],
        kind: r.photo_kind ?? "image",
        width: r.width,
        height: r.height,
        originals: {
          jpeg: original(r.jpeg_ref, r.jpeg_size, r.jpeg_hash),
          raw: original(r.raw_ref, r.raw_size, r.raw_hash),
          video: original(r.video_ref, r.video_size, r.video_hash),
        },
        images: r.current_photo_id
          ? {
              thumb: `/api/photos/${r.current_photo_id}/thumb`,
              display: `/api/photos/${r.current_photo_id}/display`,
              original: `/api/photos/${r.current_photo_id}/original`,
            }
          : null,
      })),
      nextCursor: res.rows.length > limit && last ? encodeCursor(last.updated_at, last.id) : null,
    };
  });

  // One row per species photographed (plus ones marked seen without a photo), for portfolio sites
  // and exports. Cover image URLs need photos.read to fetch.
  app.get<{ Querystring: { taxonClass?: string; include?: string } }>(
    "/life-list",
    { preHandler: requireScope("collection.read") },
    async (request) => {
      const states = request.query.include === "seen" ? ["collected", "seen"] : ["collected"];
      const params: unknown[] = [request.user!.id, states];
      let taxonFilter = "";
      if (request.query.taxonClass) {
        params.push(request.query.taxonClass.split(","));
        taxonFilter = `AND s.taxon_class = ANY($3)`;
      }
      const res = await pool.query(
        `SELECT s.id, s.scientific_name, s.common_name, s.taxon_class, s.family, us.state, us.first_collected,
                us.cover_photo_id, us.best_quality,
                (SELECT count(*)::int FROM captures c WHERE c.user_id = $1 AND c.species_id = s.id) AS photo_count,
                (SELECT max(c.taken_at) FROM captures c WHERE c.user_id = $1 AND c.species_id = s.id) AS last_photographed
         FROM user_species us JOIN species s ON s.id = us.species_id
         WHERE us.user_id = $1 AND us.state = ANY($2) ${taxonFilter}
         ORDER BY us.first_collected NULLS LAST, s.scientific_name`,
        params,
      );
      return {
        species: res.rows.map((r) => ({
          speciesId: r.id,
          scientificName: r.scientific_name,
          commonName: r.common_name,
          taxonClass: r.taxon_class,
          family: r.family,
          status: r.state === "collected" ? "photographed" : "seen",
          firstCollected: r.first_collected,
          lastPhotographed: r.last_photographed,
          photoCount: r.photo_count,
          bestRating: r.best_quality,
          coverPhotoId: r.cover_photo_id,
          coverImage: r.cover_photo_id ? `/api/photos/${r.cover_photo_id}/display` : null,
        })),
      };
    },
  );

  // Small and cheap: the life-list counter a badge, Home Assistant sensor or status display polls.
  // With regionId, also how much of that region's checklist is done.
  app.get<{ Querystring: { regionId?: string } }>(
    "/life-list/summary",
    { preHandler: requireScope("collection.read") },
    async (request, reply) => {
      const userId = request.user!.id;
      const totals = await pool.query<{ photographed: number; seen: number; photos: number }>(
        `SELECT count(*) FILTER (WHERE state = 'collected')::int AS photographed,
                count(*) FILTER (WHERE state = 'seen')::int AS seen,
                (SELECT count(*)::int FROM captures WHERE user_id = $1) AS photos
         FROM user_species WHERE user_id = $1`,
        [userId],
      );
      const byGroup = await pool.query<{ taxon_class: string; n: number }>(
        `SELECT s.taxon_class, count(*)::int AS n FROM user_species us JOIN species s ON s.id = us.species_id
         WHERE us.user_id = $1 AND us.state = 'collected' GROUP BY 1 ORDER BY 2 DESC`,
        [userId],
      );
      const latest = await pool.query(
        `SELECT s.id, s.scientific_name, s.common_name, us.first_collected, us.cover_photo_id
         FROM user_species us JOIN species s ON s.id = us.species_id
         WHERE us.user_id = $1 AND us.state = 'collected' AND us.first_collected IS NOT NULL
         ORDER BY us.first_collected DESC, us.species_id LIMIT 1`,
        [userId],
      );
      const thisYear = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM user_species
         WHERE user_id = $1 AND state = 'collected' AND first_collected >= date_trunc('year', now())`,
        [userId],
      );
      let region = null;
      if (request.query.regionId) {
        const r = await pool.query<{ name: string; checklist: number; photographed: number }>(
          `SELECT reg.name,
                  (SELECT count(*)::int FROM region_species rs WHERE rs.region_id = reg.id) AS checklist,
                  (SELECT count(*)::int FROM region_species rs JOIN user_species us ON us.species_id = rs.species_id
                     AND us.user_id = $2 AND us.state = 'collected' WHERE rs.region_id = reg.id) AS photographed
           FROM regions reg WHERE reg.id = $1`,
          [request.query.regionId, userId],
        );
        if (!r.rows[0]) return reply.code(404).send({ error: "Unknown region" });
        region = { regionId: request.query.regionId, name: r.rows[0].name, photographed: r.rows[0].photographed, checklistSize: r.rows[0].checklist };
      }
      const l = latest.rows[0];
      return {
        photographedSpecies: totals.rows[0].photographed,
        seenOnlySpecies: totals.rows[0].seen,
        photos: totals.rows[0].photos,
        newThisYear: thisYear.rows[0].n,
        byTaxonClass: Object.fromEntries(byGroup.rows.map((g) => [g.taxon_class, g.n])),
        latestLifer: l
          ? {
              speciesId: l.id,
              scientificName: l.scientific_name,
              commonName: l.common_name,
              firstCollected: l.first_collected,
              coverImage: l.cover_photo_id ? `/api/photos/${l.cover_photo_id}/display` : null,
            }
          : null,
        region,
      };
    },
  );
}
