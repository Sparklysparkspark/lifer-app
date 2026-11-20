// Saved spots (migrations 168, 181): the named places a photo can be filed under in one go. Applying
// a spot gives photos its name and region in a background job (with Undo); photos with their own
// point keep it, and only photos with none take the spot's centre. Deleting a spot never touches a
// photo; renaming one can relabel its photos too.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { requireAuth } from "../auth/session.js";
import { IdParams, Nullable, Ok, Uuid, notFoundOnInvalidId, replies, withSchemas } from "../lib/schema.js";
import {
  PLACE_MAX,
  SYNC_PLACE_MAX,
  applyLocation,
  applyLocations,
  locationJob,
  startLocationJob,
  type LocationEdit,
} from "../captures/locationHistory.js";
import { regionAt } from "../regions/regionAt.js";
import { metresTo } from "./spotArea.js";
import { distanceM } from "./placePrivacy.js";
import { localityAt } from "./gazetteer.js";

// Photos this close to a spot are offered it even when its radius is smaller: a pond or feeder.
export const NEARBY_METRES = 150;
// A photo's own point further than this past the radius is more likely a wrong place than a wrong camera.
const FAR_MARGIN_METRES = 1000;
const NAME_MAX = 500;
const GEOPRIVACY = ["open", "obscured", "private"] as const;
const LOCALITY_SOURCES = ["gazetteer", "region", "inaturalist", "user"] as const;
const ORIGINS = ["map", "photo", "inaturalist"] as const;

export const Spot = Type.Object({
  id: Uuid(),
  name: Type.String(),
  lat: Type.Number(),
  lon: Type.Number(),
  regionId: Nullable(Uuid()),
  regionName: Nullable(Type.String()),
  geoprivacy: Type.Enum([...GEOPRIVACY]),
  radiusM: Type.Integer(),
  locality: Nullable(Type.String()),
  localitySource: Nullable(Type.Enum([...LOCALITY_SOURCES])),
  notes: Nullable(Type.String()),
  origin: Type.Enum([...ORIGINS]),
  lastUsedAt: Nullable(Type.String({ format: "date-time" })),
  photoCount: Type.Integer({ description: "Photos filed under this spot's name or taken inside it" }),
});
const Radius = Type.Integer({ minimum: 25, maximum: 5000 });
const Locality = Nullable(Type.String({ maxLength: 300, description: "Null or empty: worked out from the region" }));
const Notes = Nullable(Type.String({ maxLength: 2000 }));
const SpotFields = {
  name: Type.String({ minLength: 1, maxLength: NAME_MAX }),
  lat: Type.Number({ minimum: -90, maximum: 90 }),
  lon: Type.Number({ minimum: -180, maximum: 180 }),
  regionId: Type.Optional(Nullable(Uuid())),
  geoprivacy: Type.Optional(Type.Enum([...GEOPRIVACY])),
  radiusM: Type.Optional(Radius),
  locality: Type.Optional(Locality),
  notes: Type.Optional(Notes),
};
const spotNotFound = notFoundOnInvalidId("Spot not found");

interface SpotRow {
  id: string;
  name: string;
  lat: number;
  lon: number;
  region_id: string | null;
  region_name: string | null;
  geoprivacy: (typeof GEOPRIVACY)[number];
  radius_m: number;
  locality: string | null;
  locality_source: (typeof LOCALITY_SOURCES)[number] | null;
  notes: string | null;
  origin: (typeof ORIGINS)[number];
  last_used_at: string | null;
  photo_count: number;
}

const toSpot = (r: SpotRow) => ({
  id: r.id,
  name: r.name,
  lat: r.lat,
  lon: r.lon,
  regionId: r.region_id,
  regionName: r.region_name,
  geoprivacy: r.geoprivacy,
  radiusM: r.radius_m,
  locality: r.locality,
  localitySource: r.locality_source,
  notes: r.notes,
  origin: r.origin,
  lastUsedAt: r.last_used_at,
  photoCount: r.photo_count,
});

const SPOT_SELECT = `SELECT s.id, s.name, s.lat::float8 AS lat, s.lon::float8 AS lon, s.region_id, r.name AS region_name,
    s.geoprivacy, s.radius_m, s.locality, s.locality_source, s.notes, s.origin,
    to_char(s.last_used_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_used_at,
    (SELECT COUNT(*)::int FROM captures c WHERE c.user_id = s.user_id AND (lower(c.location_label) = lower(s.name)
      OR (c.lat IS NOT NULL AND c.lon IS NOT NULL
          AND c.lat BETWEEN s.lat - s.radius_m / 111320.0 AND s.lat + s.radius_m / 111320.0
          AND ${metresTo("s")} <= s.radius_m))) AS photo_count
  FROM saved_spots s LEFT JOIN regions r ON r.id = s.region_id`;

/** The nearest town within 25 km, else the region's name (PLACE-05). */
async function workedOutLocality(lat: number, lon: number, regionId: string | null) {
  const found = await localityAt(lat, lon, regionId);
  return { locality: found?.locality ?? null, source: found?.source ?? null };
}

/** What choosing a spot writes: photos with their own point keep it unless `moveOwnPoints`. */
export const spotEdit = (
  spot: { name: string; lat: number; lon: number; region_id: string | null; radius_m: number },
  moveOwnPoints = false,
): LocationEdit => ({
  lat: spot.lat,
  lon: spot.lon,
  label: spot.name,
  regionId: spot.region_id,
  source: "spot",
  accuracyM: spot.radius_m,
  keep: moveOwnPoints ? undefined : "own",
});

/** Photos whose own point (not one a spot gave them) lies well outside the spot, with the
 *  furthest distance in km. */
export function farPhotos(
  spot: { lat: number; lon: number; radius_m: number },
  photos: Array<{ lat: number | null; lon: number | null; location_source: string | null }>,
): { count: number; km: number } {
  let count = 0;
  let furthest = 0;
  for (const p of photos) {
    if (p.lat === null || p.lon === null || p.location_source === "spot") continue;
    const d = distanceM(spot, { lat: p.lat, lon: p.lon });
    if (d <= spot.radius_m + FAR_MARGIN_METRES) continue;
    count++;
    furthest = Math.max(furthest, d);
  }
  return { count, km: Math.round(furthest / 1000) };
}

export async function savedSpotRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.get(
    "/saved-spots",
    { preValidation: requireAuth, schema: { response: replies(Type.Object({ spots: Type.Array(Spot) })) } },
    async (request) => {
      const res = await pool.query<SpotRow>(`${SPOT_SELECT} WHERE s.user_id = $1 ORDER BY lower(s.name)`, [
        request.user!.id,
      ]);
      return { spots: res.rows.map(toSpot) };
    },
  );

  // The region is looked up from the point unless the caller names one.
  async function resolveRegion(lat: number, lon: number, given: string | null | undefined) {
    return given === undefined ? ((await regionAt(lat, lon))?.id ?? null) : given;
  }

  app.post(
    "/saved-spots",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          { ...SpotFields, origin: Type.Optional(Type.Enum([...ORIGINS])) },
          { additionalProperties: false },
        ),
        response: replies(Spot),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const { name, lat, lon, regionId, geoprivacy, radiusM, locality, notes, origin } = request.body;
      const trimmed = name.trim();
      if (!trimmed) return reply.code(400).send({ error: "Give the spot a name" });
      const region = await resolveRegion(lat, lon, regionId);
      const typed = locality?.trim();
      const place = typed ? { locality: typed, source: "user" as const } : await workedOutLocality(lat, lon, region);
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO saved_spots (user_id, name, lat, lon, region_id, geoprivacy, radius_m, locality, locality_source, notes, origin)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'open'), COALESCE($7, 100), $8, $9, $10, COALESCE($11, 'map'))
         ON CONFLICT DO NOTHING RETURNING id`,
        [
          userId,
          trimmed,
          lat,
          lon,
          region,
          geoprivacy ?? null,
          radiusM ?? null,
          place.locality,
          place.source,
          notes?.trim() || null,
          origin ?? null,
        ],
      );
      if (!inserted.rows[0]) return reply.code(409).send({ error: "You already have a spot with that name" });
      const res = await pool.query<SpotRow>(`${SPOT_SELECT} WHERE s.id = $1`, [inserted.rows[0].id]);
      return toSpot(res.rows[0]);
    },
  );

  app.patch(
    "/saved-spots/:id",
    {
      preValidation: requireAuth,
      config: spotNotFound,
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            name: Type.Optional(SpotFields.name),
            lat: Type.Optional(SpotFields.lat),
            lon: Type.Optional(SpotFields.lon),
            regionId: SpotFields.regionId,
            geoprivacy: SpotFields.geoprivacy,
            radiusM: SpotFields.radiusM,
            locality: SpotFields.locality,
            notes: SpotFields.notes,
            renamePhotos: Type.Optional(
              Type.Boolean({ description: "A new name also relabels the photos filed under the old one (undoable)" }),
            ),
          },
          { additionalProperties: false },
        ),
        response: replies(
          Type.Object({
            ...Spot.properties,
            relabelled: Type.Optional(
              Type.Integer({ description: "Photos relabelled; 0 when it runs in the background" }),
            ),
            background: Type.Optional(
              Type.Boolean({ description: "Over 5,000 photos: follow GET /captures/location/status" }),
            ),
          }),
        ),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const { name, lat, lon, regionId, geoprivacy, radiusM, locality, notes, renamePhotos } = request.body;
      if ((lat === undefined) !== (lon === undefined))
        return reply.code(400).send({ error: "Send both lat and lon, or neither" });
      const trimmed = name?.trim();
      if (name !== undefined && !trimmed) return reply.code(400).send({ error: "Give the spot a name" });
      const current = (
        await pool.query<{
          name: string;
          lat: number;
          lon: number;
          region_id: string | null;
          locality: string | null;
          locality_source: string | null;
        }>(
          `SELECT name, lat::float8 AS lat, lon::float8 AS lon, region_id, locality, locality_source
           FROM saved_spots WHERE id = $1 AND user_id = $2`,
          [request.params.id, userId],
        )
      ).rows[0];
      if (!current) return reply.code(404).send({ error: "Spot not found" });
      const renaming = !!renamePhotos && trimmed !== undefined && trimmed !== current.name;
      if (renaming && locationJob.status.running)
        return reply.code(409).send({ error: "Wait for the photos being placed to finish" });

      // Moving a spot re-looks-up its region unless one is named.
      const region =
        lat !== undefined && lon !== undefined
          ? await resolveRegion(lat, lon, regionId)
          : regionId === undefined
            ? current.region_id
            : regionId;
      // A typed locality is the user's and stays; cleared, or after a move, it's worked out again.
      const typed = locality?.trim();
      const moved = lat !== undefined && lon !== undefined && (lat !== current.lat || lon !== current.lon);
      const place = typed
        ? { locality: typed, source: "user" }
        : locality !== undefined || ((moved || region !== current.region_id) && current.locality_source !== "user")
          ? await workedOutLocality(lat ?? current.lat, lon ?? current.lon, region)
          : { locality: current.locality, source: current.locality_source };
      try {
        await pool.query(
          `UPDATE saved_spots SET name = COALESCE($3, name), lat = COALESCE($4, lat), lon = COALESCE($5, lon),
                  region_id = $6, geoprivacy = COALESCE($7, geoprivacy), radius_m = COALESCE($8, radius_m),
                  locality = $9, locality_source = $10,
                  notes = CASE WHEN $11::boolean THEN $12 ELSE notes END
           WHERE id = $1 AND user_id = $2`,
          [
            request.params.id,
            userId,
            trimmed ?? null,
            lat ?? null,
            lon ?? null,
            region,
            geoprivacy ?? null,
            radiusM ?? null,
            place.locality,
            place.source,
            notes !== undefined,
            notes?.trim() || null,
          ],
        );
      } catch (err) {
        if ((err as { code?: string }).code === "23505")
          return reply.code(409).send({ error: "You already have a spot with that name" });
        throw err;
      }
      const res = await pool.query<SpotRow>(`${SPOT_SELECT} WHERE s.id = $1`, [request.params.id]);
      const spot = toSpot(res.rows[0]);
      if (!renaming) return spot;

      // The photos filed under the old name follow it; their points stay where they are.
      const ids = (
        await pool.query<{ id: string }>(
          `SELECT id FROM captures WHERE user_id = $1 AND lower(location_label) = lower($2) LIMIT ${PLACE_MAX}`,
          [userId, current.name],
        )
      ).rows.map((r) => r.id);
      if (ids.length === 0) return { ...spot, relabelled: 0 };
      const edit: LocationEdit = { lat: spot.lat, lon: spot.lon, label: spot.name, keep: "all" };
      if (ids.length > SYNC_PLACE_MAX) {
        startLocationJob(userId, ids, edit, spot.name);
        return { ...spot, relabelled: 0, background: true };
      }
      return { ...spot, relabelled: await applyLocation(userId, ids, edit) };
    },
  );

  app.delete(
    "/saved-spots/:id",
    {
      preValidation: requireAuth,
      config: spotNotFound,
      schema: { params: IdParams, response: replies(Ok) },
    },
    async (request, reply) => {
      const res = await pool.query(`DELETE FROM saved_spots WHERE id = $1 AND user_id = $2`, [
        request.params.id,
        request.user!.id,
      ]);
      if (!res.rowCount) return reply.code(404).send({ error: "Spot not found" });
      return { ok: true };
    },
  );

  // Photos with coordinates inside a spot (its radius, or NEARBY_METRES for a small one) but not
  // filed under its name: offered, never applied on their own. $5 is the reach in metres.
  const NEARBY_SQL = `
    SELECT c.id FROM captures c
    WHERE c.user_id = $1 AND c.lat IS NOT NULL AND c.lon IS NOT NULL
      AND lower(c.location_label) IS DISTINCT FROM lower($4)
      AND 6371000 * 2 * asin(sqrt(
            power(sin(radians(c.lat::float8 - $2::float8) / 2), 2) +
            cos(radians($2::float8)) * cos(radians(c.lat::float8)) *
            power(sin(radians(c.lon::float8 - $3::float8) / 2), 2))) <= $5::float8`;
  const reach = (s: { radius_m: number }) => Math.max(s.radius_m, NEARBY_METRES);

  app.get(
    "/saved-spots/suggestions",
    {
      preValidation: requireAuth,
      schema: {
        response: replies(
          Type.Object({
            suggestions: Type.Array(Type.Object({ spotId: Uuid(), name: Type.String(), photoCount: Type.Integer() })),
          }),
        ),
      },
    },
    async (request) => {
      const userId = request.user!.id;
      const spots = await pool.query<{ id: string; name: string; lat: number; lon: number; radius_m: number }>(
        `SELECT id, name, lat::float8 AS lat, lon::float8 AS lon, radius_m FROM saved_spots WHERE user_id = $1`,
        [userId],
      );
      const suggestions: Array<{ spotId: string; name: string; photoCount: number }> = [];
      for (const s of spots.rows) {
        const n = await pool.query(NEARBY_SQL, [userId, s.lat, s.lon, s.name, reach(s)]);
        if (n.rowCount) suggestions.push({ spotId: s.id, name: s.name, photoCount: n.rowCount });
      }
      return { suggestions };
    },
  );

  const Source = {
    captureIds: Type.Optional(Type.Array(Uuid(), { minItems: 1, maxItems: PLACE_MAX })),
    tripId: Type.Optional(Uuid()),
    nearby: Type.Optional(Type.Boolean()),
  };
  type SpotForApply = { name: string; lat: number; lon: number; region_id: string | null; radius_m: number };

  async function loadSpot(id: string, userId: string): Promise<SpotForApply | undefined> {
    const res = await pool.query<SpotForApply>(
      `SELECT name, lat::float8 AS lat, lon::float8 AS lon, region_id, radius_m FROM saved_spots WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    return res.rows[0];
  }

  // Exactly one source: photos picked in the app, a whole trip, or the photos near the spot.
  async function sourceIds(
    userId: string,
    spot: SpotForApply,
    body: { captureIds?: string[]; tripId?: string; nearby?: boolean },
  ): Promise<string[]> {
    if (body.captureIds) return [...new Set(body.captureIds)];
    if (body.tripId) {
      const res = await pool.query<{ id: string }>(
        `SELECT id FROM captures WHERE user_id = $1 AND trip_id = $2 LIMIT ${PLACE_MAX + 1}`,
        [userId, body.tripId],
      );
      return res.rows.map((r) => r.id);
    }
    const res = await pool.query<{ id: string }>(`${NEARBY_SQL} LIMIT ${PLACE_MAX + 1}`, [
      userId,
      spot.lat,
      spot.lon,
      spot.name,
      reach(spot),
    ]);
    return res.rows.map((r) => r.id);
  }
  const oneSource = (b: { captureIds?: unknown; tripId?: unknown; nearby?: unknown }) =>
    [b.captureIds, b.tripId, b.nearby].filter((v) => v !== undefined).length === 1;

  // Before choosing: how many of these photos have their own point well away from the spot, so
  // the picker can ask instead of filing them somewhere they weren't taken.
  app.post(
    "/saved-spots/:id/far",
    {
      preValidation: requireAuth,
      config: spotNotFound,
      schema: {
        params: IdParams,
        body: Type.Object(Source, { additionalProperties: false }),
        response: replies(Type.Object({ count: Type.Integer(), km: Type.Integer({ description: "The furthest" }) })),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      if (!oneSource(request.body)) return reply.code(400).send({ error: "Choose photos, a trip or nearby photos" });
      const spot = await loadSpot(request.params.id, userId);
      if (!spot) return reply.code(404).send({ error: "Spot not found" });
      const ids = await sourceIds(userId, spot, request.body);
      const photos = await pool.query<{ lat: number | null; lon: number | null; location_source: string | null }>(
        `SELECT lat::float8 AS lat, lon::float8 AS lon, location_source FROM captures
         WHERE user_id = $1 AND id = ANY($2::uuid[]) AND lat IS NOT NULL`,
        [userId, ids],
      );
      return farPhotos(spot, photos.rows);
    },
  );

  app.post(
    "/saved-spots/:id/apply",
    {
      preValidation: requireAuth,
      config: spotNotFound,
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            ...Source,
            moveOwnPoints: Type.Optional(
              Type.Boolean({ description: "Also move photos with their own point (camera GPS) to the spot's centre" }),
            ),
            wait: Type.Optional(
              Type.Boolean({ description: "Up to 5,000 photos: apply now and answer how many, instead of a job" }),
            ),
          },
          { additionalProperties: false },
        ),
        response: replies(Type.Object({ ok: Type.Boolean(), applied: Type.Optional(Type.Integer()) })),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      if (!oneSource(request.body)) return reply.code(400).send({ error: "Choose photos, a trip or nearby photos" });
      const spot = await loadSpot(request.params.id, userId);
      if (!spot) return reply.code(404).send({ error: "Spot not found" });
      if (locationJob.status.running) return reply.code(409).send({ error: "Photos are already being placed" });
      const ids = await sourceIds(userId, spot, request.body);
      if (ids.length === 0) return reply.code(400).send({ error: "There are no photos to apply this spot to" });
      if (ids.length > PLACE_MAX)
        return reply.code(400).send({ error: `Apply to at most ${PLACE_MAX} photos at once` });
      const edit = spotEdit(spot, request.body.moveOwnPoints);
      const used = () => pool.query(`UPDATE saved_spots SET last_used_at = now() WHERE id = $1`, [request.params.id]);
      if (request.body.wait && ids.length <= SYNC_PLACE_MAX) {
        const applied = await applyLocation(userId, ids, edit);
        await used();
        return { ok: true, applied };
      }
      // Progress and Undo are the shared location job's: GET /captures/location/status.
      if (!startLocationJob(userId, ids, edit, spot.name))
        return reply.code(409).send({ error: "Photos are already being placed" });
      await used();
      return { ok: true };
    },
  );

  // The places chosen on the import screen, applied once the photos are in: one transaction and one
  // undo step (POST /captures/location/undo) for every group.
  app.post(
    "/places/apply",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          {
            places: Type.Array(
              Type.Object(
                {
                  captureIds: Type.Array(Uuid(), { minItems: 1, maxItems: PLACE_MAX }),
                  spotId: Type.Optional(
                    Uuid({ description: "A saved spot: its name, region, and centre for photos without a point" }),
                  ),
                  lat: Type.Optional(Type.Number({ minimum: -90, maximum: 90 })),
                  lon: Type.Optional(Type.Number({ minimum: -180, maximum: 180 })),
                  regionId: Type.Optional(
                    Uuid({ description: "Alone: only the region. With lat and lon: the point's region" }),
                  ),
                  label: Type.Optional(
                    Type.String({
                      minLength: 1,
                      maxLength: NAME_MAX,
                      description: "Written instead of the spot's name",
                    }),
                  ),
                },
                { additionalProperties: false },
              ),
              { minItems: 1, maxItems: 10_000 },
            ),
          },
          { additionalProperties: false },
        ),
        response: replies(Type.Object({ applied: Type.Integer() })),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const { places } = request.body;
      if (places.reduce((n, p) => n + p.captureIds.length, 0) > PLACE_MAX)
        return reply.code(400).send({ error: `Apply to at most ${PLACE_MAX} photos at once` });
      if (locationJob.status.running) return reply.code(409).send({ error: "Photos are already being placed" });
      const parts: Array<{ captureIds: string[]; edit: LocationEdit }> = [];
      const spotIds = new Set<string>();
      for (const p of places) {
        if ((p.lat === undefined) !== (p.lon === undefined))
          return reply.code(400).send({ error: "Send both lat and lon, or neither" });
        let edit: LocationEdit;
        if (p.spotId) {
          const spot = await loadSpot(p.spotId, userId);
          if (!spot) return reply.code(404).send({ error: "Spot not found" });
          spotIds.add(p.spotId);
          edit = { ...spotEdit(spot), label: p.label ?? spot.name };
        } else if (p.lat !== undefined && p.lon !== undefined) {
          // A point another group's camera gave: photos with their own point keep it.
          edit = { lat: p.lat, lon: p.lon, source: "map", regionId: p.regionId ?? null, label: p.label, keep: "own" };
        } else if (p.regionId) edit = { lat: null, lon: null, regionId: p.regionId, label: p.label, keep: "all" };
        else return reply.code(400).send({ error: "Give each place a spot, a point or a region" });
        parts.push({ captureIds: p.captureIds, edit });
      }
      const applied = await applyLocations(userId, parts);
      if (spotIds.size > 0)
        await pool.query(`UPDATE saved_spots SET last_used_at = now() WHERE id = ANY($1::uuid[]) AND user_id = $2`, [
          [...spotIds],
          userId,
        ]);
      return { applied };
    },
  );
}
