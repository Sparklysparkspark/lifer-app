// Archived species, species hidden from a region, "seen" marks and targets live only in the
// database, so a fresh install pointed at an existing photo library lost all of them, even though
// its photos, albums and trips came back (those already keep .lifer records in the library; see
// albums/albumIndex.ts). This keeps the same kind of record for the rest of the collection:
// <library>/.lifer/collection-state.json, next to the photos the user already backs up.
//
// Species and regions are stored by name (scientific name, and a region's ISO code or its name
// path), not by id: ids are generated per install, so a fresh install's differ from the old one's.
// One entry per user, keyed by email; a record with exactly one user is also matched to an
// install with exactly one user, so moving from the desktop app to a server keeps it too.
//
// Rewritten (whole, a couple of seconds after the last change) whenever that state changes, and
// read back when a user's database has none of it: at startup, and after the library reimport
// tool, which is how a fresh install is pointed at an old library.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { ORIGINALS_DIR } from "../config.js";
import { writeFileAtomicSync } from "./atomicWrite.js";
import { ensureDir } from "./safeFs.js";

export interface UserCollectionState {
  archived: string[];
  hiddenInRegions: Array<{ region: string; species: string }>;
  seen: string[];
  targets: string[];
}

interface CollectionStateFile {
  version: 1;
  updatedAt: string;
  users: Record<string, UserCollectionState>;
}

export function collectionStatePath(): string {
  return path.join(ORIGINALS_DIR, ".lifer", "collection-state.json");
}

function readStateFile(): CollectionStateFile | null {
  try {
    const parsed = JSON.parse(readFileSync(collectionStatePath(), "utf8")) as CollectionStateFile;
    return parsed && parsed.version === 1 && parsed.users ? parsed : null;
  } catch {
    return null;
  }
}

// A region's lasting name: its first ISO-style code ("CA-BC"), else its name path from the top
// ("North America / Canada / British Columbia").
const REGION_KEY_SQL = `COALESCE(r.external_codes[1], (
  WITH RECURSIVE up AS (
    SELECT r.id, r.name, r.parent_id, 0 AS depth
    UNION ALL
    SELECT p.id, p.name, p.parent_id, up.depth + 1 FROM regions p JOIN up ON p.id = up.parent_id
  )
  SELECT string_agg(name, ' / ' ORDER BY depth DESC) FROM up
))`;

export async function currentCollectionState(userId: string): Promise<UserCollectionState> {
  const [archived, hidden, states] = await Promise.all([
    pool.query<{ name: string }>(
      `SELECT s.scientific_name AS name FROM user_archived_species a JOIN species s ON s.id = a.species_id WHERE a.user_id = $1 ORDER BY 1`,
      [userId],
    ),
    pool.query<{ region: string; species: string }>(
      `SELECT ${REGION_KEY_SQL} AS region, s.scientific_name AS species
         FROM region_species_hidden h JOIN regions r ON r.id = h.region_id JOIN species s ON s.id = h.species_id
        WHERE h.user_id = $1 ORDER BY 1, 2`,
      [userId],
    ),
    pool.query<{ name: string; state: string | null; is_target: boolean }>(
      `SELECT s.scientific_name AS name, us.state, us.is_target FROM user_species us JOIN species s ON s.id = us.species_id
        WHERE us.user_id = $1 AND (us.state = 'seen' OR us.is_target) ORDER BY 1`,
      [userId],
    ),
  ]);
  return {
    archived: archived.rows.map((r) => r.name),
    hiddenInRegions: hidden.rows,
    seen: states.rows.filter((r) => r.state === "seen").map((r) => r.name),
    targets: states.rows.filter((r) => r.is_target).map((r) => r.name),
  };
}

// Users a restore has been tried for since this server started. A fresh desktop install creates
// its user on the app's first request, and a fresh server gets its user at sign-up, both after
// startup, so the first time each user's session is checked is the other moment to try.
const restoreTried = new Set<string>();

const isEmpty = (s: UserCollectionState) => s.archived.length + s.hiddenInRegions.length + s.seen.length + s.targets.length === 0;

/** Writes this user's current state into the library's record. */
export async function saveCollectionState(userId: string): Promise<void> {
  const user = (await pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId])).rows[0];
  if (!user) return;
  const state = await currentCollectionState(userId);
  const file = readStateFile() ?? { version: 1 as const, updatedAt: "", users: {} };
  // Nothing to keep and nothing kept before: don't create a file just to say so.
  if (isEmpty(state) && !file.users[user.email]) return;
  file.users[user.email] = state;
  file.updatedAt = new Date().toISOString();
  await ensureDir(path.dirname(collectionStatePath()));
  writeFileAtomicSync(collectionStatePath(), JSON.stringify(file, null, 2));
}

const pendingSaves = new Map<string, ReturnType<typeof setTimeout>>();
/** Saves a couple of seconds after the last change, so a bulk archive writes once. */
export function scheduleCollectionStateSave(userId: string): void {
  clearTimeout(pendingSaves.get(userId));
  pendingSaves.set(
    userId,
    setTimeout(() => {
      pendingSaves.delete(userId);
      saveCollectionState(userId).catch((err) => console.warn("[collection-state] couldn't save:", (err as Error).message));
    }, 2000),
  );
}

// Every route that changes this state. Matched after a successful response rather than wired into
// each route, so a new route in one of these families is covered too.
const STATE_ROUTES = [
  /^\/api\/species\/[^/]+\/(archive|seen|target)$/,
  /^\/api\/archive\/bulk$/,
  /^\/api\/regions\/[^/]+\/species\/[^/]+\/hide$/,
  /^\/api\/imports\//,
];

/** Called from /auth/me: tries a restore the first time each user shows up after startup. */
export function tryRestoreCollectionStateOnce(userId: string): void {
  if (restoreTried.has(userId)) return;
  restoreTried.add(userId);
  restoreCollectionState(userId).catch((err) => console.warn("[collection-state] couldn't restore:", (err as Error).message));
}

export function registerCollectionStateSaving(app: FastifyInstance): void {
  app.addHook("onResponse", async (request, reply) => {
    if (reply.statusCode >= 400 || !request.user) return;
    const url = request.url.split("?")[0];
    const userId = request.user.id;
    if (request.method === "GET") return;
    if (STATE_ROUTES.some((re) => re.test(url))) scheduleCollectionStateSave(userId);
  });
}

async function speciesIdsByName(names: string[]): Promise<Map<string, string>> {
  if (names.length === 0) return new Map();
  // Where a name matches more than one row, the one that isn't extinct wins.
  const res = await pool.query<{ name: string; id: string }>(
    `SELECT DISTINCT ON (s.scientific_name) s.scientific_name AS name, s.id
       FROM species s LEFT JOIN species_traits t ON t.species_id = s.id
      WHERE s.scientific_name = ANY($1)
      ORDER BY s.scientific_name, COALESCE(t.fully_extinct, false)`,
    [names],
  );
  return new Map(res.rows.map((r) => [r.name, r.id]));
}

/** Applies a saved state to a user whose database has none of it. Returns how much was restored,
 *  or null when there was nothing to do. */
export async function restoreCollectionState(userId: string): Promise<{ restored: number; notFound: number } | null> {
  const file = readStateFile();
  if (!file) return null;
  const current = await currentCollectionState(userId);
  if (!isEmpty(current)) return null; // this install already has its own; the database wins
  const user = (await pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId])).rows[0];
  if (!user) return null;
  const entries = Object.entries(file.users);
  let saved = file.users[user.email];
  if (!saved && entries.length === 1) {
    const userCount = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`)).rows[0].n;
    if (userCount === 1) saved = entries[0][1];
  }
  if (!saved || isEmpty(saved)) return null;

  const names = [...new Set([...saved.archived, ...saved.seen, ...saved.targets, ...saved.hiddenInRegions.map((h) => h.species)])];
  const ids = await speciesIdsByName(names);
  if (ids.size === 0) return null; // catalog not installed yet: try again later
  const regionRes = await pool.query<{ key: string; id: string }>(`SELECT ${REGION_KEY_SQL} AS key, r.id FROM regions r`);
  const regionIds = new Map(regionRes.rows.map((r) => [r.key, r.id]));

  let restored = 0;
  let notFound = 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const name of saved.archived) {
      const id = ids.get(name);
      if (!id) { notFound++; continue; }
      await client.query(`INSERT INTO user_archived_species (user_id, species_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, id]);
      restored++;
    }
    for (const h of saved.hiddenInRegions) {
      const id = ids.get(h.species);
      const regionId = regionIds.get(h.region);
      if (!id || !regionId) { notFound++; continue; }
      await client.query(`INSERT INTO region_species_hidden (user_id, region_id, species_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [userId, regionId, id]);
      restored++;
    }
    for (const name of saved.seen) {
      const id = ids.get(name);
      if (!id) { notFound++; continue; }
      // Never downgrades: a species you've since photographed stays collected.
      await client.query(`INSERT INTO user_species (user_id, species_id, state) VALUES ($1, $2, 'seen') ON CONFLICT (user_id, species_id) DO NOTHING`, [userId, id]);
      restored++;
    }
    for (const name of saved.targets) {
      const id = ids.get(name);
      if (!id) { notFound++; continue; }
      await client.query(
        `INSERT INTO user_species (user_id, species_id, is_target) VALUES ($1, $2, true) ON CONFLICT (user_id, species_id) DO UPDATE SET is_target = true`,
        [userId, id],
      );
      restored++;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  console.log(`[collection-state] Restored ${restored} archived, hidden, seen and target entries from the library${notFound ? ` (${notFound} not in this catalog)` : ""}.`);
  return { restored, notFound };
}

/** At startup: restore for users with no state of their own, and write a first record for
 *  users who have state but no record yet (an install from before this existed). A user with no
 *  state is never saved here: that would overwrite a record the restore couldn't apply yet (the
 *  catalog still installing, say) with an empty one. */
export async function syncCollectionStateOnStartup(): Promise<void> {
  const users = (await pool.query<{ id: string }>(`SELECT id FROM users`)).rows;
  for (const { id } of users) {
    try {
      restoreTried.add(id);
      if (await restoreCollectionState(id)) continue;
      if (!isEmpty(await currentCollectionState(id))) await saveCollectionState(id);
    } catch (err) {
      console.warn("[collection-state]", (err as Error).message);
    }
  }
}
