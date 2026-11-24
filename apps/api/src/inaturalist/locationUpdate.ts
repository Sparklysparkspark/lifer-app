// A location set in Lifer for an observation sent without one, passed on to iNaturalist. The queue
// is one install setting per user (no table): an entry per observation, merged in one statement so
// a running update and a new request never overwrite each other's entries.
import { pool } from "@lifer/core/db.js";
import { log } from "@lifer/core/lib/log.js";
import { placeForSend } from "../places/placePrivacy.js";
import { getInstallSetting } from "../lib/installSettings.js";
import {
  fetchJwt,
  fetchObservationLocation,
  InatHttpError,
  updateObservationLocation,
  wait,
  type NetDeps,
} from "./client.js";

export type LocationState = "waiting" | "sent" | "failed" | "conflict";
/** Why an update failed, worded by the page. */
export type LocationReason = "reconnect" | "notFound" | "refused" | "noLocation";
export interface LocationEntry {
  state: LocationState;
  at: string;
  reason?: LocationReason;
  /** The user chose Replace: iNaturalist's own location is overwritten. */
  replace?: boolean;
}
export interface FlushResult {
  updated: number;
  waiting: number;
  failed: number;
  conflicts: number;
  /** Already placed on iNaturalist since sending, for the Replace or Keep question. */
  conflictIds: string[];
}

const GAP_MS = 1000;
const queueKey = (userId: string) => `inat_location_updates:${userId}`;

export async function loadLocationQueue(userId: string): Promise<Record<string, LocationEntry>> {
  return (await getInstallSetting<Record<string, LocationEntry>>(pool, queueKey(userId))) ?? {};
}

/** Sets or (with null) removes entries, leaving the others as they are. */
export async function setLocationEntries(userId: string, patch: Record<string, LocationEntry | null>): Promise<void> {
  const removed = Object.keys(patch).filter((id) => patch[id] === null);
  const set = Object.fromEntries(Object.entries(patch).filter(([, e]) => e !== null));
  await pool.query(
    `INSERT INTO install_settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = (install_settings.value - $3::text[]) || $2::jsonb, updated_at = now()`,
    [queueKey(userId), JSON.stringify(set), removed],
  );
}

// About a metre: iNaturalist hands back the point it was given, give or take float rounding.
const samePoint = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
  Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lon - b.lon) < 1e-5;

/** Sends one observation's location from its photos. Returns its new entry, or null when the
 *  observation is no longer linked here. Throws what iNaturalist or the network threw. */
async function updateOne(
  userId: string,
  jwt: string,
  observationId: string,
  replace: boolean,
  deps: NetDeps,
): Promise<LocationEntry | null> {
  const rows = (
    await pool.query<{
      capture_id: string;
      lat: number | null;
      lon: number | null;
      submitted_lat: number | null;
      submitted_lon: number | null;
    }>(
      `SELECT o.capture_id, c.lat::float8 AS lat, c.lon::float8 AS lon,
              o.submitted_lat::float8 AS submitted_lat, o.submitted_lon::float8 AS submitted_lon
       FROM capture_inaturalist_observations o
       JOIN captures c ON c.id = o.capture_id
       WHERE o.inat_observation_id = $1 AND c.user_id = $2 AND o.photo_sent
       ORDER BY c.taken_at NULLS LAST, c.id`,
      [observationId, userId],
    )
  ).rows;
  if (rows.length === 0) return null;
  const now = () => new Date().toISOString();
  const located = rows.find((r) => r.lat !== null && r.lon !== null);
  if (!located) return { state: "failed", at: now(), reason: "noLocation" };
  const point = { lat: located.lat!, lon: located.lon! };
  const captureIds = rows.map((r) => r.capture_id);

  if (!replace) {
    // Never overwrite a pin the user put on iNaturalist since sending: ask first.
    const remote = await fetchObservationLocation(jwt, observationId, deps);
    if (remote.lat !== null && remote.lon !== null) {
      const there = { lat: remote.lat, lon: remote.lon };
      if (samePoint(there, point)) return markSent(observationId, captureIds, point, remote.positionalAccuracyMeters);
      const sent = rows[0];
      const sentThere = sent.submitted_lat !== null && sent.submitted_lon !== null;
      if (!sentThere || !samePoint(there, { lat: sent.submitted_lat!, lon: sent.submitted_lon! }))
        return { state: "conflict", at: now() };
    }
    await (deps.sleep ?? ((ms: number) => wait(ms, deps.signal)))(GAP_MS);
  }

  const place = await placeForSend(userId, captureIds, located.capture_id, null, null);
  await updateObservationLocation(
    jwt,
    observationId,
    {
      ...point,
      positionalAccuracy: place.positionalAccuracy,
      // An update only ever hides more: an open place leaves iNaturalist's own setting alone.
      geoprivacy: place.geoprivacy && place.geoprivacy !== "open" ? place.geoprivacy : null,
    },
    deps,
  );
  return markSent(observationId, captureIds, point, place.positionalAccuracy);
}

// What Lifer sent is now this point, so the To finish check and a later update compare against it.
async function markSent(
  observationId: string,
  captureIds: string[],
  point: { lat: number; lon: number },
  accuracy: number | null,
): Promise<LocationEntry> {
  await pool.query(
    `UPDATE capture_inaturalist_observations
     SET submitted_lat = $2, submitted_lon = $3, submitted_positional_accuracy = $4
     WHERE inat_observation_id = $1 AND capture_id = ANY($5::uuid[])`,
    [observationId, point.lat, point.lon, accuracy, captureIds],
  );
  return { state: "sent", at: new Date().toISOString() };
}

/** Sends every waiting location, including ones queued while it runs. Offline or iNaturalist
 *  down: the rest stay waiting for the next try. A revoked sign-in fails them with "reconnect". */
export async function flushLocationUpdates(
  userId: string,
  account: { accessToken: string },
  opts: { deps?: NetDeps; onProgress?: (processed: number, total: number) => void } = {},
): Promise<FlushResult> {
  const deps = opts.deps ?? {};
  const sleep = deps.sleep ?? ((ms: number) => wait(ms, deps.signal));
  const result: FlushResult = { updated: 0, waiting: 0, failed: 0, conflicts: 0, conflictIds: [] };
  const tried = new Set<string>();
  let jwt: string | null = null;
  for (;;) {
    const queue = await loadLocationQueue(userId);
    const due = Object.keys(queue).filter((id) => queue[id].state === "waiting" && !tried.has(id));
    if (due.length === 0) return result;
    for (const id of due) {
      deps.signal?.throwIfAborted();
      if (tried.size > 0) await sleep(GAP_MS);
      tried.add(id);
      let entry: LocationEntry | null;
      try {
        jwt ??= await fetchJwt(account.accessToken);
        entry = await updateOne(userId, jwt, id, queue[id].replace === true, deps);
      } catch (err) {
        if (deps.signal?.aborted) throw err;
        log.warn(`[inaturalist] couldn't update observation ${id}'s location: ${(err as Error).message}`);
        const status = err instanceof InatHttpError ? err.status : null;
        if (status === null || status === 429 || status >= 500) {
          // Offline or iNaturalist is down: everything left waits for the next try.
          result.waiting += due.length - due.indexOf(id);
          return result;
        }
        const reason: LocationReason = status === 401 ? "reconnect" : status === 404 ? "notFound" : "refused";
        if (reason === "reconnect") {
          // Every one left would fail the same way until the account is connected again.
          const left = due.slice(due.indexOf(id));
          const at = new Date().toISOString();
          await setLocationEntries(userId, Object.fromEntries(left.map((x) => [x, { state: "failed", at, reason }])));
          result.failed += left.length;
          return result;
        }
        entry = { state: "failed", at: new Date().toISOString(), reason };
      }
      await setLocationEntries(userId, { [id]: entry });
      if (entry?.state === "sent") result.updated += 1;
      else if (entry?.state === "conflict") result.conflictIds.push(id);
      else if (entry?.state === "failed") result.failed += 1;
      result.conflicts = result.conflictIds.length;
      opts.onProgress?.(tried.size, tried.size + due.length - due.indexOf(id) - 1);
    }
  }
}
