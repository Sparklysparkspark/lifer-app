// What the iNaturalist send flow shows about place before sending: the privacy the send will use
// (the same rule as placeForSend), a point for the picker's Nearby group, and a place the photos
// seem to be at but aren't filed under ("This looks like King Fisher Pond").
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { PLACE_MAX } from "../captures/locationHistory.js";
import { requireAuth } from "../auth/session.js";
import { Nullable, Open, Uuid, replies, withSchemas } from "../lib/schema.js";
import { distanceM, placesOfPhotos, strictest, type PhotoForPrivacy, type PlaceForPrivacy } from "./placePrivacy.js";

// The same reach as /places/locate's "recognised": inside the place, or near a small one's centre.
const RECOGNISE_M = 150;

type Spot = PlaceForPrivacy & { id: string };
export interface SendHint {
  geoprivacy: "open" | "obscured" | "private" | null;
  point: { lat: number; lon: number } | null;
  looksLike: { id: string; name: string; locality: string | null; geoprivacy: Spot["geoprivacy"] } | null;
}

export const SendHintSchema = {
  geoprivacy: Nullable(
    Type.Union([Type.Literal("open"), Type.Literal("obscured"), Type.Literal("private")], {
      description: "What the send will use, from the places the photos are filed under or inside; null when none",
    }),
  ),
  point: Nullable(Type.Object({ lat: Type.Number(), lon: Type.Number() }, { description: "A located photo's point" })),
  looksLike: Nullable(
    Type.Object(
      {
        id: Uuid(),
        name: Type.String(),
        locality: Nullable(Type.String()),
        geoprivacy: Type.Union([Type.Literal("open"), Type.Literal("obscured"), Type.Literal("private")]),
      },
      { description: "A place the photos are at but not filed under, to offer" },
    ),
  ),
};

/** One hint per group of the user's photos (a group is one observation's photos). */
export async function sendHints(userId: string, groups: string[][]): Promise<SendHint[]> {
  const ids = [...new Set(groups.flat())];
  const [spots, photos] = await Promise.all([
    pool.query<Spot>(
      `SELECT id, name, lat::float8 AS lat, lon::float8 AS lon, radius_m, geoprivacy, locality
       FROM saved_spots WHERE user_id = $1`,
      [userId],
    ),
    ids.length === 0
      ? { rows: [] as PhotoForPrivacy[] }
      : pool.query<PhotoForPrivacy>(
          `SELECT id, lat::float8 AS lat, lon::float8 AS lon, location_label, location_source,
                  location_accuracy_m::float8 AS location_accuracy_m
           FROM captures WHERE user_id = $1 AND id = ANY($2::uuid[])`,
          [userId, ids],
        ),
  ]);
  const byId = new Map(photos.rows.map((p) => [p.id, p]));
  return groups.map((group) => {
    const rows = group.flatMap((id) => byId.get(id) ?? []);
    const matched = placesOfPhotos(spots.rows, rows);
    const located = rows.find((p) => p.lat !== null && p.lon !== null);
    const point = located ? { lat: located.lat!, lon: located.lon! } : null;
    const labels = new Set(rows.flatMap((p) => (p.location_label ? [p.location_label.toLowerCase()] : [])));
    // Offered only while none of the photos is filed under a place yet.
    const filed = spots.rows.some((s) => labels.has(s.name.toLowerCase()));
    let looksLike: SendHint["looksLike"] = null;
    if (point && !filed) {
      let best = Infinity;
      for (const s of spots.rows) {
        const d = distanceM(s, point);
        if (d <= Math.max(s.radius_m, RECOGNISE_M) && d < best) {
          best = d;
          looksLike = { id: s.id, name: s.name, locality: s.locality, geoprivacy: s.geoprivacy };
        }
      }
    }
    return { geoprivacy: matched.length > 0 ? strictest(matched.map((s) => s.geoprivacy)) : null, point, looksLike };
  });
}

export async function sendHintRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  // Before a send from the Gallery: which photos have no point, so the user can choose a place first.
  app.post(
    "/places/send-hints",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          { captureIds: Type.Array(Uuid(), { minItems: 1, maxItems: PLACE_MAX }) },
          { additionalProperties: false },
        ),
        response: replies(
          Open({
            withoutLocation: Type.Array(Uuid(), { description: "The photos with no point" }),
            ...SendHintSchema,
          }),
        ),
      },
    },
    async (request) => {
      const userId = request.user!.id;
      const ids = [...new Set(request.body.captureIds)];
      const res = await pool.query<{ id: string }>(
        `SELECT id FROM captures WHERE user_id = $1 AND id = ANY($2::uuid[]) AND (lat IS NULL OR lon IS NULL)`,
        [userId, ids],
      );
      const [hint] = await sendHints(userId, [ids]);
      return { withoutLocation: res.rows.map((r) => r.id), ...hint };
    },
  );
}
