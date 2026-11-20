// What a paired phone's key may see of a photo's place and files. A device key is a copy of the
// library on a phone that can be lost, so server file paths never go to it and a sensitive
// species' coordinates stay home (the same sensitiveCapturesAmong test shares and exports use).
import type { FastifyRequest } from "fastify";
import { pool } from "@lifer/core/db.js";
import { sensitiveCapturesAmong } from "../settings/metadataSettings.js";

interface Placed {
  capture_id: string;
  species_id: string;
  region_id: string | null;
}

/** For any API key (a device key too), the captures among these whose place it never gets, by the
 *  rule shares use. Null for a session, which sees everything. */
export async function sensitiveForKey(request: FastifyRequest, rows: Placed[]): Promise<Set<string> | null> {
  return request.apiKeyName === undefined ? null : sensitiveCapturesAmong(request.user!.id, rows);
}

/** An item without its coordinates and place name when its capture is in `sensitive`. */
export function withoutSensitivePlace<T extends { captureId: string; lat: unknown; lon: unknown }>(
  item: T,
  sensitive: Set<string> | null,
): T {
  if (!sensitive?.has(item.captureId)) return item;
  return {
    ...item,
    lat: null,
    lon: null,
    ...("locationLabel" in item ? { locationLabel: null } : {}),
    // Whether the time fits the sun there says something about the place, so it stays home too.
    ...("timeMaybeWrong" in item ? { timeMaybeWrong: null } : {}),
  };
}

/** A gallery item as a device key sees it: no file paths, no place for a sensitive species. */
export function galleryItemForDevice<T extends { captureId: string; lat: unknown; lon: unknown }>(
  item: T,
  sensitive: Set<string>,
): T & { originalRef: null; rawRef: null } {
  return { ...withoutSensitivePlace(item, sensitive), originalRef: null, rawRef: null };
}

/** Capture changes for a device key: a sensitive species loses its coordinates and place name. */
export async function changesForDevice<T extends { id: string; regionId: string | null }>(
  userId: string,
  items: (T & { lat: number | null; lon: number | null; locationLabel: string | null })[],
) {
  if (items.length === 0) return items;
  const species = await pool.query<{ id: string; species_id: string }>(
    `SELECT id, species_id FROM captures_all WHERE user_id = $1 AND id = ANY($2::uuid[])`,
    [userId, items.map((i) => i.id)],
  );
  const speciesOf = new Map(species.rows.map((r) => [r.id, r.species_id]));
  const sensitive = await sensitiveCapturesAmong(
    userId,
    items.flatMap((i) =>
      speciesOf.has(i.id) ? [{ capture_id: i.id, species_id: speciesOf.get(i.id)!, region_id: i.regionId }] : [],
    ),
  );
  return items.map((i) => (sensitive.has(i.id) ? { ...i, lat: null, lon: null, locationLabel: null } : i));
}

interface Spot {
  id: string;
  lat: number;
  lon: number;
  geoprivacy: string;
  updatedAt: string;
}

/** A saved spots page for a device key: "obscured" spots are rounded to about 11 km and "private"
 *  ones stay home, sent as purged so a phone that synced the spot before it went private drops it. */
export function spotsForDevice<T extends Spot, P extends { items: T[]; purged: { ref: string; deletedAt: string }[] }>(
  page: P,
): P {
  const round = (n: number) => Math.round(n * 10) / 10;
  const hidden = page.items.filter((s) => s.geoprivacy === "private");
  return {
    ...page,
    items: page.items
      .filter((s) => s.geoprivacy !== "private")
      .map((s) => (s.geoprivacy === "obscured" ? { ...s, lat: round(s.lat), lon: round(s.lon) } : s)),
    purged: [...page.purged, ...hidden.map((s) => ({ ref: s.id, deletedAt: s.updatedAt }))],
  };
}
