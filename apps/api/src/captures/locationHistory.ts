// Every location change (placing, removing, filing under a saved spot) goes through here, so one
// undo history per user covers them all. Big changes run as one background job with progress.
// shortcut: held in memory, so the history is gone after a restart; persist if it needs to outlive that.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { createLimiter } from "@lifer/core/lib/concurrency.js";
import { requireScope } from "../auth/session.js";
import { createJob, type JobContext } from "../lib/job.js";
import { Nullable, jobStatusFields, replies, withSchemas } from "../lib/schema.js";
import { followPlaceChange } from "../uploads/reorganizeOriginals.js";
import { syncCaptureXmpSidecarsLogged } from "../uploads/xmpSidecarSync.js";
import { queueRecheck } from "./recheck.js";

export const LOCATION_HISTORY_STEPS = 20;
/** Up to this many photos change at once; more run as a background job. */
export const SYNC_PLACE_MAX = 5000;
export const PLACE_MAX = 200_000;
const BATCH = 500;

/** The new location. A label or region left undefined stays as it is. */
export interface LocationEdit {
  lat: number | null;
  lon: number | null;
  /** Null clears the place name. */
  label?: string | null;
  /** Set only when not null: a spot without a region keeps each photo's own. */
  regionId?: string | null;
  /** Where the new point came from: 'map' for placed or typed, 'spot' for a place's centre. */
  source?: "map" | "spot" | null;
  /** How precise the new point is, in metres (a place's radius). */
  accuracyM?: number | null;
  /** 'own': a photo with its own point (camera GPS, placed, iNaturalist) keeps it, and one filed
   *  under a place moves. 'all': no point changes, only the label and region. */
  keep?: "own" | "all";
}

interface Before {
  id: string;
  lat: string | null;
  lon: string | null;
  region_id: string | null;
  location_label: string | null;
  location_source: string | null;
  location_accuracy_m: string | null;
}
interface Change {
  before: Before[];
  /** Whether the label and region changed too, so undo rewrites only what the change touched. */
  placeChanged: boolean;
}

const histories = new Map<string, Change[]>();

export const canUndoLocation = (userId: string) => (histories.get(userId)?.length ?? 0) > 0;

function record(userId: string, change: Change): void {
  const list = histories.get(userId) ?? [];
  list.push(change);
  if (list.length > LOCATION_HISTORY_STEPS) list.shift();
  histories.set(userId, list);
}

// In the background: exiftool is slow on many files. A point alone needs only the GPS rewritten;
// a label or region change can also move files between place folders.
async function followFiles(userId: string, ids: string[], placeChanged: boolean): Promise<void> {
  if (ids.length === 0) return;
  if (placeChanged) {
    await followPlaceChange(userId, ids, { replaceGps: true, replaceLabel: true, replacePlace: true });
    return;
  }
  const limit = createLimiter(4);
  for (const id of ids) void limit(() => syncCaptureXmpSidecarsLogged(userId, id, { replaceGps: true }));
}

// One statement, so the snapshot and the write see the same rows.
function writeBatch(
  q: Pick<typeof pool, "query">,
  userId: string,
  ids: string[],
  edit: LocationEdit,
): Promise<{ rows: Before[] }> {
  return q.query<Before>(
    `WITH old AS (
           SELECT id, lat, lon, region_id, location_label, location_source, location_accuracy_m,
                  NOT ($10::text = 'all' OR ($10::text = 'own' AND lat IS NOT NULL
                       AND location_source IS DISTINCT FROM 'spot')) AS move
           FROM captures WHERE id = ANY($1::uuid[]) AND user_id = $2
         )
         UPDATE captures c SET
                lat = CASE WHEN old.move THEN $3::numeric ELSE c.lat END,
                lon = CASE WHEN old.move THEN $4::numeric ELSE c.lon END,
                location_source = CASE WHEN old.move THEN $8::text ELSE c.location_source END,
                location_accuracy_m = CASE WHEN old.move THEN $9::numeric ELSE c.location_accuracy_m END,
                location_label = CASE WHEN $5::boolean THEN $6 ELSE c.location_label END,
                region_id = COALESCE($7::uuid, c.region_id)
         FROM old WHERE c.id = old.id
         RETURNING old.id, old.lat::text AS lat, old.lon::text AS lon, old.region_id, old.location_label,
                   old.location_source, old.location_accuracy_m::text AS location_accuracy_m`,
    [
      ids,
      userId,
      edit.lat,
      edit.lon,
      edit.label !== undefined,
      edit.label ?? null,
      edit.regionId ?? null,
      edit.lat === null ? null : (edit.source ?? null),
      edit.lat === null ? null : (edit.accuracyM ?? null),
      edit.keep ?? "none",
    ],
  );
}

const touchesPlace = (edit: LocationEdit) => edit.label !== undefined || !!edit.regionId;

/** Several location edits (an import's groups) in one transaction and one undo step, so one Undo
 *  puts every photo back. A photo listed twice takes its first edit. Returns how many changed. */
export async function applyLocations(
  userId: string,
  parts: Array<{ captureIds: string[]; edit: LocationEdit }>,
): Promise<number> {
  const seen = new Set<string>();
  const change: Change = { before: [], placeChanged: parts.some((p) => touchesPlace(p.edit)) };
  const regionChanged: string[] = [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const { captureIds, edit } of parts) {
      const ids = captureIds.filter((id) => !seen.has(id) && seen.add(id));
      for (let i = 0; i < ids.length; i += BATCH) {
        const { rows } = await writeBatch(client, userId, ids.slice(i, i + BATCH), edit);
        change.before.push(...rows);
        if (edit.regionId) regionChanged.push(...rows.map((r) => r.id));
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  if (change.before.length === 0) return 0;
  record(userId, change);
  await followFiles(
    userId,
    change.before.map((b) => b.id),
    change.placeChanged,
  );
  queueRecheck(userId, regionChanged);
  return change.before.length;
}

/** Sets the location of this user's photos in batches, recording what each had before as one undo
 *  step. A cancelled job keeps the step for the batches it finished. Returns how many changed. */
export async function applyLocation(
  userId: string,
  captureIds: string[],
  edit: LocationEdit,
  ctx?: JobContext<LocationJobResult>,
): Promise<number> {
  const ids = [...new Set(captureIds)];
  const placeChanged = touchesPlace(edit);
  const change: Change = { before: [], placeChanged };
  record(userId, change);
  ctx?.update({ phase: "photos", processed: 0, total: ids.length });
  try {
    for (let i = 0; i < ids.length; i += BATCH) {
      ctx?.throwIfCancelled();
      const res = await writeBatch(pool, userId, ids.slice(i, i + BATCH), edit);
      change.before.push(...res.rows);
      ctx?.update({ processed: Math.min(i + BATCH, ids.length) });
    }
  } finally {
    // Files follow whatever was written, even when a cancel stopped it part way.
    ctx?.update({ phase: "files" });
    const changed = change.before.map((b) => b.id);
    // Nothing changed (another user's ids, all trashed): no empty step to undo.
    if (changed.length === 0)
      histories.set(
        userId,
        (histories.get(userId) ?? []).filter((c) => c !== change),
      );
    await followFiles(userId, changed, placeChanged);
    if (edit.regionId && changed.length > 0) queueRecheck(userId, changed);
  }
  return change.before.length;
}

/** Puts back what the user's latest location change replaced. Returns how many photos. */
export async function undoLocation(userId: string): Promise<number> {
  const change = histories.get(userId)?.pop();
  if (!change) return 0;
  const { before } = change;
  for (let i = 0; i < before.length; i += BATCH) {
    const rows = before.slice(i, i + BATCH);
    await pool.query(
      `UPDATE captures c SET lat = v.lat, lon = v.lon, region_id = v.region_id, location_label = v.location_label,
              location_source = v.source, location_accuracy_m = v.accuracy
       FROM unnest($1::uuid[], $2::numeric[], $3::numeric[], $4::uuid[], $5::text[], $6::text[], $7::numeric[])
         AS v(id, lat, lon, region_id, location_label, source, accuracy)
       WHERE c.id = v.id AND c.user_id = $8`,
      [
        rows.map((r) => r.id),
        rows.map((r) => r.lat),
        rows.map((r) => r.lon),
        rows.map((r) => r.region_id),
        rows.map((r) => r.location_label),
        rows.map((r) => r.location_source),
        rows.map((r) => r.location_accuracy_m),
        userId,
      ],
    );
  }
  await followFiles(
    userId,
    before.map((b) => b.id),
    change.placeChanged,
  );
  return before.length;
}

export interface LocationJobResult {
  applied: number;
  /** The saved spot the photos were filed under, or null for a plain point. */
  spotName: string | null;
}
export const locationJob = createJob<LocationJobResult>("location-change");
let jobOwner: string | null = null;

export const locationJobRunningFor = (userId: string) => locationJob.status.running && jobOwner === userId;

/** Starts a big change in the background. False when one is already running. */
export function startLocationJob(
  userId: string,
  captureIds: string[],
  edit: LocationEdit,
  spotName: string | null,
): boolean {
  const started = locationJob.start(async (ctx) => ({
    applied: await applyLocation(userId, captureIds, edit, ctx),
    spotName,
  }));
  if (started) jobOwner = userId;
  return started;
}

export async function locationRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  const Status = Type.Object({
    ...jobStatusFields(Type.Object({ applied: Type.Integer(), spotName: Nullable(Type.String()) })),
    canUndo: Type.Boolean(),
  });

  app.get(
    "/captures/location/status",
    { preValidation: requireScope("photos.write"), schema: { response: replies(Status) } },
    async (request) => {
      const userId = request.user!.id;
      // Someone else's run on a shared server shows as idle.
      const mine = jobOwner === null || jobOwner === userId;
      return {
        ...(mine
          ? locationJob.status
          : { ...locationJob.status, running: false, processed: null, total: null, result: null }),
        canUndo: canUndoLocation(userId),
      };
    },
  );

  app.post(
    "/captures/location/cancel",
    {
      preValidation: requireScope("photos.write"),
      schema: { response: replies(Type.Object({ cancelled: Type.Boolean() })) },
    },
    async (request) => ({ cancelled: locationJobRunningFor(request.user!.id) && locationJob.cancel() }),
  );

  app.post(
    "/captures/location/undo",
    {
      preValidation: requireScope("photos.write"),
      schema: { response: replies(Type.Object({ restored: Type.Integer(), canUndo: Type.Boolean() })) },
    },
    async (request) => {
      const userId = request.user!.id;
      // Undo during the user's own job stops it first, then reverts what it did: never interleaved.
      if (locationJobRunningFor(userId)) {
        locationJob.cancel();
        await locationJob.settled();
      }
      const restored = await undoLocation(userId);
      return { restored, canUndo: canUndoLocation(userId) };
    },
  );
}
