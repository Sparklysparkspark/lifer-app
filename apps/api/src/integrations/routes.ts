// Endpoints for integrations rather than Lifer's own UI: stable field names, paging, incremental
// sync. The OpenAPI document is built from these schemas, with the prose in openapi.ts
// (integrationsDocs.test.ts checks both against the routes and the API guide).
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { Nullable, Uuid, replies, routeCatalog, withSchemas } from "../lib/schema.js";
import { requireScope } from "../auth/session.js";
import { buildOpenApi } from "./openapi.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

// Opaque to callers: "<updated_at>|<capture id>", base64url. updated_at stays text at full
// microsecond precision, since a millisecond Date would sort before its row and repeat it.
function encodeCursor(updatedAt: string, id: string): string {
  return Buffer.from(`${updatedAt}|${id}`).toString("base64url");
}
const UPDATED_AT_TEXT = `to_char(c.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
function decodeCursor(cursor: string): { updatedAt: string; id: string } | null {
  const [updatedAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (!updatedAt || !id || Number.isNaN(Date.parse(updatedAt)) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { updatedAt, id };
}

const fileName = (ref: string | null) => (ref ? (ref.split(/[\\/]/).pop() ?? null) : null);

const StrNull = Nullable(Type.String());
const NumNull = Nullable(Type.Number());
const IntNull = Nullable(Type.Integer());
// Dates come from Postgres as Date objects; no `format` here, since the serializer would rewrite them.
const Time = (description?: string) => Type.String(description ? { description } : {});
const TimeNull = (description?: string) => Nullable(Time(description));

const OriginalFile = Nullable(
  Type.Object({
    fileName: StrNull,
    sizeBytes: IntNull,
    sha256: Nullable(Type.String({ description: "SHA-256 of the file's bytes" })),
  }),
);

const CaptureItem = Type.Object({
  captureId: Uuid(),
  photoId: Nullable(Uuid({ description: "Current photo; image URLs below use it" })),
  speciesId: Uuid(),
  scientificName: Type.String(),
  commonName: StrNull,
  taxonClass: StrNull,
  additionalSpecies: Type.Array(Type.Object({ speciesId: Uuid(), scientificName: Type.String(), commonName: StrNull })),
  takenAt: TimeNull("ISO 8601"),
  createdAt: Time("ISO 8601"),
  updatedAt: Type.String({ description: "Full-precision time of the last change; pass it back as `since`" }),
  deletedAt: TimeNull("Set when the photo is in the trash (only with includeDeleted=1)"),
  lat: NumNull,
  lon: NumNull,
  regionId: Nullable(Uuid()),
  regionName: StrNull,
  locationLabel: StrNull,
  tripId: Nullable(Uuid()),
  camera: Type.Object({
    model: StrNull,
    lens: StrNull,
    focalLengthMm: NumNull,
    aperture: NumNull,
    shutter: StrNull,
    iso: IntNull,
  }),
  rating: Nullable(Type.Integer({ description: "1-5" })),
  tags: Type.Array(Type.String()),
  kind: Type.Enum(["image", "video"]),
  width: IntNull,
  height: IntNull,
  originals: Type.Object({ jpeg: OriginalFile, raw: OriginalFile, video: OriginalFile }),
  images: Nullable(
    Type.Object(
      { thumb: Type.String(), display: Type.String(), original: Type.String() },
      { description: "Paths under the server; fetch with a photos.read key" },
    ),
  ),
});

const LifeListSpecies = Type.Object({
  speciesId: Uuid(),
  scientificName: Type.String(),
  commonName: StrNull,
  taxonClass: StrNull,
  family: StrNull,
  status: Type.Enum(["photographed", "seen"]),
  firstCollected: TimeNull(),
  lastPhotographed: TimeNull(),
  photoCount: Type.Integer(),
  bestRating: IntNull,
  coverPhotoId: Nullable(Uuid()),
  coverImage: StrNull,
});

const LifeListSummary = Type.Object({
  photographedSpecies: Type.Integer(),
  seenOnlySpecies: Type.Integer(),
  photos: Type.Integer(),
  newThisYear: Type.Integer(),
  byTaxonClass: Type.Record(Type.String(), Type.Integer()),
  latestLifer: Nullable(
    Type.Object({
      speciesId: Uuid(),
      scientificName: Type.String(),
      commonName: StrNull,
      firstCollected: TimeNull(),
      coverImage: StrNull,
    }),
  ),
  region: Nullable(
    Type.Object({ regionId: Uuid(), name: Type.String(), photographed: Type.Integer(), checklistSize: Type.Integer() }),
  ),
});

export async function integrationRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  // Public: describes the API, holds no data. Built on first request, once every route exists.
  let openApi: object | undefined;
  app.get("/openapi.json", { schema: {} }, async () => (openApi ??= buildOpenApi(routeCatalog.values())));

  // Every capture, oldest change first, for syncing. includeDeleted=1 returns trashed photos with
  // deletedAt set; permanently deleted ones simply stop appearing.
  app.get(
    "/captures",
    {
      preValidation: requireScope("photos.read"),
      schema: {
        querystring: Type.Object({
          // Not format date-time: an `updatedAt` passed back has microseconds, and a plain date is
          // fine too. The handler checks it parses.
          since: Type.Optional(
            Type.String({ description: "Only photos changed after this time (an `updatedAt` from an earlier call)" }),
          ),
          cursor: Type.Optional(Type.String({ description: "`nextCursor` from the previous page" })),
          // Larger pages are capped rather than refused.
          limit: Type.Optional(Type.Integer({ minimum: 1, description: "Page size, 1-500 (default 100)" })),
          speciesId: Type.Optional(Uuid({ description: "Only photos showing this species (primary or additional)" })),
          includeDeleted: Type.Optional(
            Type.Enum(["0", "1"], { description: "1 to include photos in the trash, with deletedAt set" }),
          ),
        }),
        response: replies(Type.Object({ items: Type.Array(CaptureItem), nextCursor: StrNull })),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const limit = Math.min(request.query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const params: unknown[] = [userId];
      const where = ["c.user_id = $1"];
      if (request.query.includeDeleted !== "1") where.push("c.deleted_at IS NULL");
      if (request.query.since) {
        if (Number.isNaN(Date.parse(request.query.since)))
          return reply.code(400).send({ error: "since must be an ISO 8601 date-time" });
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
    },
  );

  // One row per species photographed or marked seen. Cover image URLs need photos.read.
  app.get(
    "/life-list",
    {
      preValidation: requireScope("collection.read"),
      schema: {
        querystring: Type.Object({
          taxonClass: Type.Optional(Type.String({ description: "Comma-separated taxon classes, e.g. aves,mammalia" })),
          include: Type.Optional(Type.Enum(["seen"], { description: "`seen` to include seen-only species" })),
        }),
        response: replies(Type.Object({ species: Type.Array(LifeListSpecies) })),
      },
    },
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
          status: r.state === "collected" ? ("photographed" as const) : ("seen" as const),
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

  // A cheap life-list counter for polling. With regionId, also that region's checklist progress.
  app.get(
    "/life-list/summary",
    {
      preValidation: requireScope("collection.read"),
      // A malformed region id is just an unknown region, as it always was.
      config: { invalidInput: { querystring: { status: 404, error: "Unknown region" } } },
      schema: {
        querystring: Type.Object({
          regionId: Type.Optional(Uuid({ description: "Also report progress on this region's checklist" })),
        }),
        response: replies(LifeListSummary),
      },
    },
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
        region = {
          regionId: request.query.regionId,
          name: r.rows[0].name,
          photographed: r.rows[0].photographed,
          checklistSize: r.rows[0].checklist,
        };
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
