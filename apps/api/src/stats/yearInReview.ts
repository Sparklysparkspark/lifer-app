// Year in Review: one year of the user's own visible captures. Figures agree with Stats and Home
// (species are user_species rows in state 'collected'; photos are rows of the captures view).
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { requireAuth } from "../auth/session.js";
import { replies, withSchemas, Nullable, Open, Uuid } from "../lib/schema.js";
import { sensitiveCapturesAmong } from "../settings/metadataSettings.js";
import { KEEPER_FILTER, loadGearUsage } from "./overview.js";

type Db = Pick<PoolClient, "query">;

const PLACE_CELL_DEGREES = 0.1; // same cell as Home, about 11 km
const PLACE_LIMIT = 300;
const FIRSTS_LIMIT = 200;
const BEST_LIMIT = 12;
const GEAR_LIMIT = 5;
// Same order as Home's BEST_PHOTO_ORDER: the user's rating, then the newest.
const BEST_PHOTO_ORDER = `c.quality_rating DESC NULLS LAST, c.taken_at DESC NULLS LAST, c.id`;
const IN_YEAR = `c.user_id = $1 AND c.taken_at IS NOT NULL AND EXTRACT(year FROM c.taken_at) = $2`;

interface YearCounts {
  photos: number;
  newSpecies: number;
  trips: number;
  places: number;
}

export interface YearInReview {
  year: number;
  years: number[];
  counts: YearCounts;
  previous: YearCounts;
  firsts: {
    total: number;
    items: Array<{
      speciesId: string;
      scientificName: string;
      commonName: string | null;
      firstTakenAt: string | null;
      photoId: string | null;
    }>;
  };
  bestPhotos: Array<{
    captureId: string;
    photoId: string;
    speciesId: string | null;
    width: number | null;
    height: number | null;
  }>;
  monthsByGroup: Array<{ month: number; taxonClass: string; count: number }>;
  trips: Array<{
    id: string;
    name: string;
    start: string | null;
    end: string | null;
    photoCount: number;
    coverPhotoId: string | null;
  }>;
  places: Array<{ lat: number; lon: number; photoCount: number; label: string | null }>;
  gear: {
    cameras: Array<{ model: string; photoCount: number }>;
    lenses: Array<{ model: string; photoCount: number }>;
  };
}

/** Place clusters for the year, with sensitive species' photos left out entirely so the page can be shared. */
async function loadPlaces(db: Db, userId: string, year: number) {
  const res = await db.query<{
    capture_id: string;
    species_id: string;
    region_id: string | null;
    lat: number;
    lon: number;
    location_label: string | null;
  }>(
    `SELECT c.id AS capture_id, c.species_id, c.region_id, c.lat, c.lon, c.location_label
     FROM captures c WHERE ${IN_YEAR} AND c.lat IS NOT NULL AND c.lon IS NOT NULL`,
    [userId, year],
  );
  const hidden = await sensitiveCapturesAmong(
    userId,
    res.rows.filter((r) => r.species_id),
  );
  const cells = new Map<string, { lat: number; lon: number; photoCount: number; labels: Map<string, number> }>();
  for (const r of res.rows) {
    if (hidden.has(r.capture_id)) continue;
    const lat = Math.round(r.lat / PLACE_CELL_DEGREES) * PLACE_CELL_DEGREES;
    const lon = Math.round(r.lon / PLACE_CELL_DEGREES) * PLACE_CELL_DEGREES;
    const cell = cells.get(`${lat}:${lon}`) ?? { lat, lon, photoCount: 0, labels: new Map() };
    cell.photoCount++;
    if (r.location_label) cell.labels.set(r.location_label, (cell.labels.get(r.location_label) ?? 0) + 1);
    cells.set(`${lat}:${lon}`, cell);
  }
  return [...cells.values()]
    .sort((a, b) => b.photoCount - a.photoCount)
    .map((c) => ({
      lat: c.lat,
      lon: c.lon,
      photoCount: c.photoCount,
      label: [...c.labels.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    }));
}

async function loadCounts(db: Db, userId: string, year: number) {
  const [counts, places] = await Promise.all([
    db.query<YearCounts>(
      `SELECT (SELECT COUNT(*)::int FROM captures c WHERE ${IN_YEAR}) AS photos,
              -- Matches Stats' new lifers per month (user_species.first_collected), summed over the year.
              (SELECT COUNT(*)::int FROM user_species us WHERE us.user_id = $1 AND us.state = 'collected'
                 AND EXTRACT(year FROM us.first_collected) = $2) AS "newSpecies",
              (SELECT COUNT(DISTINCT c.trip_id)::int FROM captures c WHERE ${IN_YEAR} AND c.trip_id IS NOT NULL) AS trips`,
      [userId, year],
    ),
    loadPlaces(db, userId, year),
  ]);
  return { places, counts: { ...counts.rows[0], places: places.length } };
}

export async function loadYearInReview(db: Db, userId: string, requested: number | null): Promise<YearInReview> {
  const yearsRes = await db.query<{ y: number }>(
    `SELECT DISTINCT EXTRACT(year FROM c.taken_at)::int AS y FROM captures c
     WHERE c.user_id = $1 AND c.taken_at IS NOT NULL ORDER BY y DESC`,
    [userId],
  );
  const years = yearsRes.rows.map((r) => r.y);
  const year = requested ?? years[0] ?? new Date().getFullYear();

  const [current, previous, firsts, best, months, trips, gear] = await Promise.all([
    loadCounts(db, userId, year),
    loadCounts(db, userId, year - 1),
    db.query<{
      species_id: string;
      scientific_name: string;
      common_name: string | null;
      first_taken_at: string | null;
      photo_id: string | null;
      total: number;
    }>(
      `SELECT s.id AS species_id, s.scientific_name, s.common_name, f.taken_at AS first_taken_at,
              f.current_photo_id AS photo_id, COUNT(*) OVER ()::int AS total
       FROM user_species us JOIN species s ON s.id = us.species_id
       LEFT JOIN LATERAL (
         SELECT c.taken_at, c.current_photo_id FROM captures c
         WHERE c.user_id = $1 AND c.species_id = us.species_id AND c.taken_at IS NOT NULL
         ORDER BY c.taken_at, c.id LIMIT 1
       ) f ON true
       WHERE us.user_id = $1 AND us.state = 'collected' AND EXTRACT(year FROM us.first_collected) = $2
       ORDER BY us.first_collected, s.scientific_name LIMIT ${FIRSTS_LIMIT}`,
      [userId, year],
    ),
    db.query<{
      capture_id: string;
      photo_id: string;
      species_id: string | null;
      width: number | null;
      height: number | null;
    }>(
      `SELECT c.id AS capture_id, c.current_photo_id AS photo_id, c.species_id, p.width, p.height
       FROM captures c JOIN photos p ON p.id = c.current_photo_id
       WHERE ${IN_YEAR} ORDER BY ${BEST_PHOTO_ORDER} LIMIT ${BEST_LIMIT}`,
      [userId, year],
    ),
    db.query<{ month: number; taxon_class: string; count: number }>(
      `SELECT EXTRACT(month FROM c.taken_at)::int AS month, s.taxon_class, COUNT(*)::int AS count
       FROM captures c JOIN species s ON s.id = c.species_id
       WHERE ${IN_YEAR} GROUP BY 1, 2 ORDER BY 1, 2`,
      [userId, year],
    ),
    db.query<{
      id: string;
      name: string;
      start: string | null;
      end: string | null;
      photo_count: number;
      cover: string | null;
    }>(
      `SELECT t.id, t.name, t.start_date::text AS start, t.end_date::text AS "end", COUNT(*)::int AS photo_count,
              (array_agg(c.current_photo_id ORDER BY (c.id = t.cover_capture_id) DESC, ${BEST_PHOTO_ORDER})
                 FILTER (WHERE c.current_photo_id IS NOT NULL))[1] AS cover
       FROM trips t JOIN captures c ON c.trip_id = t.id
       WHERE ${IN_YEAR} AND t.user_id = $1
       GROUP BY t.id ORDER BY t.start_date NULLS LAST, t.name`,
      [userId, year],
    ),
    // Gear shares Stats' loader; the year is a scope fragment on the same captures alias.
    loadGearUsage(
      db,
      userId,
      `${KEEPER_FILTER} AND c.taken_at IS NOT NULL AND EXTRACT(year FROM c.taken_at) = ${Number(year)}`,
    ),
  ]);

  return {
    year,
    years,
    counts: current.counts,
    previous: previous.counts,
    firsts: {
      total: firsts.rows[0]?.total ?? 0,
      items: firsts.rows.map((r) => ({
        speciesId: r.species_id,
        scientificName: r.scientific_name,
        commonName: r.common_name,
        firstTakenAt: r.first_taken_at ? new Date(r.first_taken_at).toISOString() : null,
        photoId: r.photo_id,
      })),
    },
    bestPhotos: best.rows.map((r) => ({
      captureId: r.capture_id,
      photoId: r.photo_id,
      speciesId: r.species_id,
      width: r.width,
      height: r.height,
    })),
    monthsByGroup: months.rows.map((r) => ({ month: r.month, taxonClass: r.taxon_class, count: r.count })),
    trips: trips.rows.map((r) => ({
      id: r.id,
      name: r.name,
      start: r.start,
      end: r.end,
      photoCount: r.photo_count,
      coverPhotoId: r.cover,
    })),
    places: current.places.slice(0, PLACE_LIMIT),
    gear: {
      cameras: gear.cameras.slice(0, GEAR_LIMIT).map(({ model, photoCount }) => ({ model, photoCount })),
      lenses: gear.lenses.slice(0, GEAR_LIMIT).map(({ model, photoCount }) => ({ model, photoCount })),
    },
  };
}

const Count = Type.Integer();
const YearCountsSchema = Open({ photos: Count, newSpecies: Count, trips: Count, places: Count });

const YearInReviewResponse = Open({
  year: Count,
  years: Type.Array(Count),
  counts: YearCountsSchema,
  previous: YearCountsSchema,
  firsts: Open({
    total: Count,
    items: Type.Array(
      Open({
        speciesId: Uuid(),
        scientificName: Type.String(),
        commonName: Nullable(Type.String()),
        firstTakenAt: Nullable(Type.String()),
        photoId: Nullable(Uuid()),
      }),
    ),
  }),
  bestPhotos: Type.Array(
    Open({
      captureId: Uuid(),
      photoId: Uuid(),
      speciesId: Nullable(Uuid()),
      width: Nullable(Count),
      height: Nullable(Count),
    }),
  ),
  monthsByGroup: Type.Array(Open({ month: Count, taxonClass: Type.String(), count: Count })),
  trips: Type.Array(
    Open({
      id: Uuid(),
      name: Type.String(),
      start: Nullable(Type.String()),
      end: Nullable(Type.String()),
      photoCount: Count,
      coverPhotoId: Nullable(Uuid()),
    }),
  ),
  places: Type.Array(
    Open({ lat: Type.Number(), lon: Type.Number(), photoCount: Count, label: Nullable(Type.String()) }),
  ),
  gear: Open({
    cameras: Type.Array(Open({ model: Type.String(), photoCount: Count })),
    lenses: Type.Array(Open({ model: Type.String(), photoCount: Count })),
  }),
});

export async function yearInReviewRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  app.get(
    "/stats/year-in-review",
    {
      preValidation: requireAuth,
      schema: {
        querystring: Type.Object({ year: Type.Optional(Type.Integer({ minimum: 1900, maximum: 2200 })) }),
        response: replies(YearInReviewResponse),
      },
    },
    async (request) => loadYearInReview(pool, request.user!.id, request.query.year ?? null),
  );
}
