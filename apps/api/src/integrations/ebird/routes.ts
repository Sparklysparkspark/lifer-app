// eBird checklists the user imported from "My eBird Data": the import, the photos Lifer suggests for
// each checklist of a trip (the user confirms), the links from a photo, and gathering a checklist's
// photos into a folder for eBird's own upload. Nothing here talks to eBird.
import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { assertAllowedPath } from "@lifer/core/lib/allowedPaths.js";
import { pool } from "@lifer/core/db.js";
import { requireAuth } from "../../auth/session.js";
import { IdParams, Open, Uuid, notFoundOnInvalidId, replies, withSchemas } from "../../lib/schema.js";
import { desktopOnly } from "../../settings/requireDesktopMode.js";
import { resolveOriginalPath } from "../../storageVolumes/resolve.js";
import { parseMyEbirdData } from "./csv.js";
import { matchPhotos, type MatchChecklist } from "./match.js";

const SUB_ID = /^[A-Za-z0-9]{1,32}$/;
const MAX_CSV_BYTES = 100 * 1024 * 1024;
const PAGE = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
// Offsets beyond a day are a typo; zones differ by 26 hours at most.
const MAX_OFFSET_MIN = 26 * 60;
const SubParams = Type.Object({ id: Uuid(), subId: Type.String({ pattern: SUB_ID.source }) });

export const checklistUrl = (subId: string) => `https://ebird.org/checklist/${subId}`;

const Checklist = Open({
  subId: Type.String(),
  startedAt: Type.String({ description: "Local date and time of the count, with no time zone" }),
  hasTime: Type.Boolean(),
  location: Type.String(),
  speciesCount: Type.Integer(),
  suggested: Type.Integer({ description: "Photos Lifer suggests for it, not yet confirmed" }),
  confirmed: Type.Integer(),
  url: Type.String(),
});

interface ChecklistRow {
  sub_id: string;
  started_at: Date;
  has_time: boolean;
  location: string;
  species_count: number;
  suggested: number;
  confirmed: number;
}

const toChecklist = (r: ChecklistRow) => ({
  subId: r.sub_id,
  // The wall clock stored as UTC, so the UTC text is the local text.
  startedAt: r.started_at.toISOString().slice(0, 19),
  hasTime: r.has_time,
  location: r.location,
  speciesCount: r.species_count,
  suggested: r.suggested,
  confirmed: r.confirmed,
  url: checklistUrl(r.sub_id),
});

const COUNTS = `cardinality(e.species) AS species_count,
  count(l.capture_id) FILTER (WHERE NOT l.confirmed)::int AS suggested,
  count(l.capture_id) FILTER (WHERE l.confirmed)::int AS confirmed`;

export async function ebirdRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.post(
    "/ebird/import",
    {
      preValidation: requireAuth,
      schema: {
        response: replies(
          Type.Object({ checklists: Type.Integer(), added: Type.Integer(), skipped: Type.Array(Type.String()) }),
        ),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      let text: string | null = null;
      for await (const part of request.parts({ limits: { fileSize: MAX_CSV_BYTES } })) {
        if (part.type === "file" && part.fieldname === "file" && text === null) {
          text = (await part.toBuffer()).toString("utf8");
        } else if (part.type === "file") part.file.resume();
      }
      if (text === null) return reply.code(400).send({ error: "No file uploaded" });
      let parsed;
      try {
        parsed = parseMyEbirdData(text);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      let added = 0;
      for (let i = 0; i < parsed.checklists.length; i += PAGE) {
        const res = await pool.query(
          `INSERT INTO ebird_checklists (user_id, sub_id, started_at, has_time, duration_min, lat, lon, location, species)
           SELECT $1, v.sub_id, v.started_at, v.has_time, v.duration_min, v.lat, v.lon, v.location,
                  ARRAY(SELECT jsonb_array_elements_text(v.species))
           FROM jsonb_to_recordset($2::jsonb) AS v(sub_id text, started_at timestamptz, has_time boolean,
             duration_min int, lat float8, lon float8, location text, species jsonb)
           ON CONFLICT (user_id, sub_id) DO UPDATE SET started_at = EXCLUDED.started_at, has_time = EXCLUDED.has_time,
             duration_min = EXCLUDED.duration_min, lat = EXCLUDED.lat, lon = EXCLUDED.lon,
             location = EXCLUDED.location, species = EXCLUDED.species, imported_at = now()
           RETURNING (xmax = 0) AS inserted`,
          [
            userId,
            JSON.stringify(
              parsed.checklists.slice(i, i + PAGE).map((c) => ({
                sub_id: c.subId,
                started_at: c.startedAt,
                has_time: c.hasTime,
                duration_min: c.durationMin,
                lat: c.lat,
                lon: c.lon,
                location: c.location,
                species: c.species,
              })),
            ),
          ],
        );
        added += res.rows.filter((r) => r.inserted).length;
      }
      return { checklists: parsed.checklists.length, added, skipped: parsed.skipped };
    },
  );

  app.get(
    "/ebird/checklists",
    {
      preValidation: requireAuth,
      schema: {
        querystring: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
        response: replies(Type.Object({ total: Type.Integer(), items: Type.Array(Checklist) })),
      },
    },
    async (request) => {
      const userId = request.user!.id;
      const [total, rows] = await Promise.all([
        pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ebird_checklists WHERE user_id = $1`, [userId]),
        pool.query<ChecklistRow>(
          `SELECT e.sub_id, e.started_at, e.has_time, e.location, ${COUNTS}
           FROM ebird_checklists e LEFT JOIN capture_ebird_checklists l ON l.user_id = e.user_id AND l.sub_id = e.sub_id
           WHERE e.user_id = $1 GROUP BY e.user_id, e.sub_id ORDER BY e.started_at DESC OFFSET $2 LIMIT ${PAGE}`,
          [userId, request.query.offset ?? 0],
        ),
      ]);
      return { total: total.rows[0].n, items: rows.rows.map(toChecklist) };
    },
  );

  /** The trip's checklists: its confirmed ones plus those made while it ran. */
  app.get(
    "/trips/:id/ebird-checklists",
    {
      preValidation: requireAuth,
      config: notFoundOnInvalidId("Trip not found"),
      schema: { params: IdParams, response: replies(Type.Object({ checklists: Type.Array(Checklist) })) },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const window = await tripWindow(userId, request.params.id);
      if (!window) return reply.code(404).send({ error: "Trip not found" });
      const rows = await pool.query<ChecklistRow>(
        `SELECT e.sub_id, e.started_at, e.has_time, e.location, ${COUNTS}
         FROM ebird_checklists e
         LEFT JOIN capture_ebird_checklists l ON l.user_id = e.user_id AND l.sub_id = e.sub_id
           AND l.capture_id IN (SELECT id FROM captures WHERE trip_id = $2 AND user_id = $1)
         WHERE e.user_id = $1 AND (e.started_at >= $3 AND e.started_at < $4 OR l.capture_id IS NOT NULL)
         GROUP BY e.user_id, e.sub_id ORDER BY e.started_at LIMIT ${PAGE}`,
        [userId, request.params.id, window.from, window.to],
      );
      return { checklists: rows.rows.map(toChecklist) };
    },
  );

  /** Works out which of the trip's photos fit which checklist and records them as suggestions. */
  app.post(
    "/trips/:id/ebird-match",
    {
      preValidation: requireAuth,
      config: notFoundOnInvalidId("Trip not found"),
      schema: {
        params: IdParams,
        body: Type.Object(
          { offsetMinutes: Type.Integer({ minimum: -MAX_OFFSET_MIN, maximum: MAX_OFFSET_MIN, default: 0 }) },
          { additionalProperties: false },
        ),
        response: replies(Type.Object({ suggested: Type.Integer() })),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const window = await tripWindow(userId, request.params.id);
      if (!window) return reply.code(404).send({ error: "Trip not found" });
      const offset = request.body.offsetMinutes;
      // Wide enough that a photo shifted by the offset still finds its checklist.
      const pad = Math.abs(offset) * 60_000;
      const [lists, photos] = await Promise.all([
        pool.query<{
          sub_id: string;
          started_at: Date;
          has_time: boolean;
          duration_min: number | null;
          lat: number | null;
          lon: number | null;
          species: string[];
        }>(
          `SELECT sub_id, started_at, has_time, duration_min, lat, lon, species FROM ebird_checklists
           WHERE user_id = $1 AND started_at >= $2 AND started_at < $3`,
          [userId, new Date(window.from.getTime() - pad), new Date(window.to.getTime() + pad)],
        ),
        pool.query<{ id: string; taken_at: Date; lat: number | null; lon: number | null; scientific_name: string }>(
          `SELECT c.id, c.taken_at, c.lat::float8 AS lat, c.lon::float8 AS lon, s.scientific_name
           FROM captures c JOIN species s ON s.id = c.species_id
           WHERE c.trip_id = $2 AND c.user_id = $1 AND c.taken_at IS NOT NULL`,
          [userId, request.params.id],
        ),
      ]);
      const checklists: MatchChecklist[] = lists.rows.map((r) => ({
        subId: r.sub_id,
        startedAtMs: r.started_at.getTime(),
        hasTime: r.has_time,
        durationMin: r.duration_min,
        lat: r.lat,
        lon: r.lon,
        species: r.species,
      }));
      const matches = matchPhotos(
        photos.rows.map((p) => ({
          id: p.id,
          takenAtMs: p.taken_at.getTime(),
          lat: p.lat,
          lon: p.lon,
          species: p.scientific_name,
        })),
        checklists,
        offset,
      );
      // Unconfirmed suggestions are replaced; a confirmed link is never touched.
      await pool.query(
        `DELETE FROM capture_ebird_checklists WHERE user_id = $1 AND NOT confirmed
         AND capture_id IN (SELECT id FROM captures WHERE trip_id = $2 AND user_id = $1)`,
        [userId, request.params.id],
      );
      if (matches.length > 0)
        await pool.query(
          `INSERT INTO capture_ebird_checklists (capture_id, user_id, sub_id)
           SELECT m.capture_id, $1, m.sub_id FROM unnest($2::uuid[], $3::text[]) AS m(capture_id, sub_id)
           ON CONFLICT DO NOTHING`,
          [userId, matches.map((m) => m.captureId), matches.map((m) => m.subId)],
        );
      return { suggested: matches.length };
    },
  );

  for (const [action, confirm] of [
    ["confirm", true],
    ["dismiss", false],
  ] as const)
    app.post(
      `/trips/:id/ebird-checklists/:subId/${action}`,
      {
        preValidation: requireAuth,
        config: notFoundOnInvalidId("Trip not found"),
        schema: { params: SubParams, response: replies(Type.Object({ changed: Type.Integer() })) },
      },
      async (request) => {
        const { id, subId } = request.params;
        const trip = `capture_id IN (SELECT id FROM captures WHERE trip_id = $3 AND user_id = $1)`;
        const res = confirm
          ? await pool.query(
              `UPDATE capture_ebird_checklists SET confirmed = true WHERE user_id = $1 AND sub_id = $2 AND NOT confirmed AND ${trip}`,
              [request.user!.id, subId, id],
            )
          : await pool.query(
              `DELETE FROM capture_ebird_checklists WHERE user_id = $1 AND sub_id = $2 AND NOT confirmed AND ${trip}`,
              [request.user!.id, subId, id],
            );
        return { changed: res.rowCount ?? 0 };
      },
    );

  /** A photo's confirmed checklists, for "Open checklist on eBird". */
  app.get(
    "/captures/:id/ebird",
    {
      preValidation: requireAuth,
      config: notFoundOnInvalidId("Capture not found"),
      schema: {
        params: IdParams,
        response: replies(
          Type.Object({
            checklists: Type.Array(Type.Object({ subId: Type.String(), location: Type.String(), url: Type.String() })),
          }),
        ),
      },
    },
    async (request) => {
      const res = await pool.query<{ sub_id: string; location: string }>(
        `SELECT e.sub_id, e.location FROM capture_ebird_checklists l
         JOIN ebird_checklists e ON e.user_id = l.user_id AND e.sub_id = l.sub_id
         WHERE l.capture_id = $1 AND l.user_id = $2 AND l.confirmed ORDER BY e.started_at`,
        [request.params.id, request.user!.id],
      );
      return {
        checklists: res.rows.map((r) => ({ subId: r.sub_id, location: r.location, url: checklistUrl(r.sub_id) })),
      };
    },
  );

  /** Copies a checklist's confirmed photos into a folder, for eBird's own upload. Desktop only. */
  app.post(
    "/ebird/checklists/:subId/export",
    {
      preValidation: [requireAuth, desktopOnly],
      schema: {
        params: Type.Object({ subId: Type.String({ pattern: SUB_ID.source }) }),
        body: Type.Object({ folder: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
        response: replies(Type.Object({ copied: Type.Integer(), unavailable: Type.Integer() })),
      },
    },
    async (request) => {
      const userId = request.user!.id;
      const folder = assertAllowedPath(request.body.folder);
      const files = await pool.query<{ ref: string; volume_id: string | null; volume_relative_path: string | null }>(
        `SELECT DISTINCT ON (c.id) o.ref, o.volume_id, o.volume_relative_path
         FROM capture_ebird_checklists l
         JOIN captures_all c ON c.id = l.capture_id AND c.deleted_at IS NULL
         JOIN originals o ON o.capture_id = c.id AND o.kind = 'jpeg'
         WHERE l.user_id = $1 AND l.sub_id = $2 AND l.confirmed
         ORDER BY c.id`,
        [userId, request.params.subId],
      );
      await mkdir(folder, { recursive: true });
      let copied = 0;
      let unavailable = 0;
      for (const f of files.rows) {
        const resolved = await resolveOriginalPath(f);
        if (!resolved.connected || !resolved.path || !existsSync(resolved.path)) {
          unavailable++;
          continue;
        }
        await copyFile(resolved.path, uniqueName(folder, path.basename(resolved.path)));
        copied++;
      }
      return { copied, unavailable };
    },
  );
}

/** The days a trip covers, a day either side: its dates, else those of its photos. */
async function tripWindow(userId: string, tripId: string): Promise<{ from: Date; to: Date } | null> {
  const res = await pool.query<{ lo: Date | null; hi: Date | null }>(
    `SELECT COALESCE(t.start_date::timestamptz, (SELECT min(taken_at) FROM captures WHERE trip_id = t.id)) AS lo,
            COALESCE(t.end_date::timestamptz, (SELECT max(taken_at) FROM captures WHERE trip_id = t.id)) AS hi
     FROM trips t WHERE t.id = $1 AND t.user_id = $2`,
    [tripId, userId],
  );
  const row = res.rows[0];
  if (!row) return null;
  const lo = row.lo ?? new Date();
  const hi = row.hi ?? lo;
  // Midnight of the first day to the end of the day after the last.
  const dayStart = (d: Date) => Math.floor(d.getTime() / DAY_MS) * DAY_MS;
  return { from: new Date(dayStart(lo) - DAY_MS), to: new Date(dayStart(hi) + 3 * DAY_MS) };
}

function uniqueName(folder: string, name: string): string {
  const { name: stem, ext } = path.parse(name);
  let candidate = path.join(folder, name);
  for (let n = 2; existsSync(candidate); n++) candidate = path.join(folder, `${stem} (${n})${ext}`);
  return candidate;
}
