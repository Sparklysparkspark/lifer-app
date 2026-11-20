// Suggested places: dense groups of the user's own photo points that no place covers yet, which
// they returned to on more than one day. Deterministic grid-hash single-link clustering
// (named-places.md section 4), run in the background and cached until the photos or places change.
// Everything is local: the town name comes from the offline gazetteer.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { requireAuth } from "../auth/session.js";
import { log } from "@lifer/core/lib/log.js";
import { Nullable, Ok, replies, withSchemas } from "../lib/schema.js";
import { nearestTown } from "./gazetteer.js";
import { distanceM } from "./placePrivacy.js";

export interface PhotoPoint {
  id: string;
  lat: number;
  lon: number;
  /** The day it was taken (YYYY-MM-DD), or null when unknown. */
  day: string | null;
}
export interface PlaceArea {
  lat: number;
  lon: number;
  radius_m: number;
}
export interface Cluster {
  cell: string;
  lat: number;
  lon: number;
  radiusM: number;
  count: number;
  days: number;
}

const CELL_M = 200;
/** Two photos this close belong to the same spot. */
const LINK_M = 100;
/** A group spreading further than this from its centre is a trail, not a spot. */
const SPREAD_M = 1000;
/** Photos this far outside a place's radius still count as covered by it. */
const COVERED_MARGIN_M = 100;
const MIN_PHOTOS = 3;
const MIN_DAYS = 2;
export const MAX_SUGGESTIONS = 50;
// Snapped to the sizes the place editor offers.
const RADII = [50, 100, 250, 500, 1000];

const M_PER_DEG = 111_320;
const cellOf = (lat: number, lon: number) => {
  const dLat = CELL_M / M_PER_DEG;
  const dLon = dLat / Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  return [Math.floor(lat / dLat), Math.floor(lon / dLon)] as const;
};
export const anchorCell = (lat: number, lon: number) => cellOf(lat, lon).join(":");

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Single-link groups of points within `link` metres of another, via a 200 m grid. */
function link(points: PhotoPoint[], linkM: number): PhotoPoint[][] {
  const parent = points.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const grid = new Map<string, number[]>();
  points.forEach((p, i) => {
    const key = cellOf(p.lat, p.lon).join(":");
    const list = grid.get(key);
    if (list) list.push(i);
    else grid.set(key, [i]);
  });
  points.forEach((p, i) => {
    const [y, x] = cellOf(p.lat, p.lon);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        for (const j of grid.get(`${y + dy}:${x + dx}`) ?? []) {
          if (j <= i || distanceM(p, points[j]) > linkM) continue;
          // The smaller index is the root, so the result never depends on visiting order.
          const [a, b] = [find(i), find(j)].sort((m, n) => m - n);
          if (a !== b) parent[b] = a;
        }
  });
  const groups = new Map<number, PhotoPoint[]>();
  points.forEach((p, i) => {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(p);
    else groups.set(root, [p]);
  });
  return [...groups.values()];
}

/** The suggestions in these photo points, most photos first. Points already covered by a place
 *  and dismissed anchors are left out. Pure: the same input in any order gives the same output. */
export function clusterPoints(input: PhotoPoint[], places: PlaceArea[], dismissed: Set<string> = new Set()): Cluster[] {
  const points = input
    .filter((p) => !places.some((s) => distanceM(s, p) <= s.radius_m + COVERED_MARGIN_M))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: Cluster[] = [];
  const consider = (group: PhotoPoint[], tight: boolean) => {
    if (group.length < MIN_PHOTOS) return;
    const centre = { lat: median(group.map((p) => p.lat)), lon: median(group.map((p) => p.lon)) };
    const dists = group.map((p) => distanceM(centre, p)).sort((a, b) => a - b);
    if (dists.at(-1)! > SPREAD_M) {
      // A chain along a trail: try again tighter, and drop what's still too wide.
      if (!tight) for (const piece of link(group, LINK_M / 2)) consider(piece, true);
      return;
    }
    const days = new Set(group.flatMap((p) => (p.day ? [p.day] : []))).size;
    if (days < MIN_DAYS) return;
    const cell = anchorCell(centre.lat, centre.lon);
    if (dismissed.has(cell)) return;
    const p90 = dists[Math.min(dists.length - 1, Math.ceil(dists.length * 0.9) - 1)];
    const radiusM = RADII.find((r) => r >= p90) ?? RADII.at(-1)!;
    out.push({ cell, ...centre, radiusM, count: group.length, days });
  };
  for (const group of link(points, LINK_M)) consider(group, false);
  return out.sort((a, b) => b.count - a.count || (a.cell < b.cell ? -1 : 1)).slice(0, MAX_SUGGESTIONS);
}

export interface Suggestion extends Cluster {
  town: string | null;
  locality: string | null;
}

// Per user: the last result and what it was computed from. Recomputed only when that changes.
const cache = new Map<string, { key: string; suggestions: Suggestion[] }>();
const running = new Map<string, Promise<void>>();

async function inputKey(userId: string): Promise<string> {
  const res = await pool.query<{ k: string }>(
    `SELECT concat_ws('|',
       (SELECT count(*) || ':' || coalesce(max(updated_at)::text, '') FROM captures WHERE user_id = $1 AND lat IS NOT NULL),
       (SELECT count(*) || ':' || coalesce(max(updated_at)::text, '') FROM saved_spots WHERE user_id = $1),
       (SELECT count(*) || ':' || coalesce(max(dismissed_at)::text, '') FROM place_suggestion_dismissals WHERE user_id = $1)) AS k`,
    [userId],
  );
  return res.rows[0].k;
}

async function compute(userId: string, key: string): Promise<void> {
  const [photos, places, dismissed] = await Promise.all([
    pool.query<PhotoPoint>(
      `SELECT id, lat::float8 AS lat, lon::float8 AS lon, to_char(taken_at, 'YYYY-MM-DD') AS day
       FROM captures WHERE user_id = $1 AND lat IS NOT NULL AND lon IS NOT NULL`,
      [userId],
    ),
    pool.query<PlaceArea>(
      `SELECT lat::float8 AS lat, lon::float8 AS lon, radius_m FROM saved_spots WHERE user_id = $1`,
      [userId],
    ),
    pool.query<{ cell: string }>(`SELECT cell FROM place_suggestion_dismissals WHERE user_id = $1`, [userId]),
  ]);
  const clusters = clusterPoints(photos.rows, places.rows, new Set(dismissed.rows.map((r) => r.cell)));
  const suggestions: Suggestion[] = [];
  for (const c of clusters) {
    const town = await nearestTown(c.lat, c.lon);
    suggestions.push({ ...c, town: town?.name ?? null, locality: town?.locality ?? null });
  }
  cache.set(userId, { key, suggestions });
}

/** The cached suggestions now, starting a fresh pass in the background when the photos, places or
 *  dismissals changed since. Never waits for the pass. */
export async function placeSuggestions(userId: string): Promise<{ suggestions: Suggestion[]; updating: boolean }> {
  const key = await inputKey(userId);
  const cached = cache.get(userId);
  if (cached?.key === key) return { suggestions: cached.suggestions, updating: false };
  if (!running.has(userId)) {
    const pass = compute(userId, key)
      .catch((err) => log.warn(`[places] couldn't work out suggested places: ${(err as Error).message}`))
      .finally(() => running.delete(userId));
    running.set(userId, pass);
  }
  return { suggestions: cached?.suggestions ?? [], updating: true };
}

/** For tests: waits for a background pass to finish. */
export const suggestionsSettled = (userId: string) => running.get(userId) ?? Promise.resolve();

const SuggestionSchema = Type.Object({
  cell: Type.String({ description: "The suggestion's anchor, for dismissing it" }),
  lat: Type.Number(),
  lon: Type.Number(),
  radiusM: Type.Integer(),
  count: Type.Integer({ description: "Photos in the group" }),
  days: Type.Integer({ description: "Different days they were taken on" }),
  town: Nullable(Type.String({ description: "The nearest town within 25 km, from the offline town list" })),
  locality: Nullable(Type.String()),
});
const CellBody = Type.Object({ cell: Type.String({ minLength: 1, maxLength: 64 }) }, { additionalProperties: false });

export async function placeSuggestionRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  app.get(
    "/places/suggested",
    {
      preValidation: requireAuth,
      schema: {
        response: replies(
          Type.Object({
            suggestions: Type.Array(SuggestionSchema),
            updating: Type.Boolean({ description: "A fresh pass is running; ask again shortly" }),
          }),
        ),
      },
    },
    async (request) => placeSuggestions(request.user!.id),
  );

  app.post(
    "/places/suggested/dismiss",
    { preValidation: requireAuth, schema: { body: CellBody, response: replies(Ok) } },
    async (request) => {
      await pool.query(
        `INSERT INTO place_suggestion_dismissals (user_id, cell) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [request.user!.id, request.body.cell],
      );
      return { ok: true };
    },
  );

  // Undo for a dismissal.
  app.post(
    "/places/suggested/restore",
    { preValidation: requireAuth, schema: { body: CellBody, response: replies(Ok) } },
    async (request) => {
      await pool.query(`DELETE FROM place_suggestion_dismissals WHERE user_id = $1 AND cell = $2`, [
        request.user!.id,
        request.body.cell,
      ]);
      return { ok: true };
    },
  );
}
