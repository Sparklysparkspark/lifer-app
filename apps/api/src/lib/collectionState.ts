// Archived and region-hidden species, "seen" marks, targets, user tiers and checklist additions, recorded in
// <library>/.lifer/collection-state.json so a fresh install pointed at the library gets them back.
// Stored by name (ids differ between installs), one entry per user by email. Read back when the
// database has none of it: at startup and after a library reimport.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { TIER_ORDER, type TierValue } from "@lifer/shared";
import { pool, withTransaction } from "@lifer/core/db.js";
import { ORIGINALS_DIR } from "@lifer/core/config.js";
import { writeFileAtomicSync } from "./atomicWrite.js";
import { ensureDir } from "@lifer/core/lib/safeFs.js";
import { log } from "@lifer/core/lib/log.js";
import { foldInnerAdditions } from "../regions/checklistAdditions.js";

async function downloadedPackIds(): Promise<string[]> {
  return (await pool.query<{ pack_id: string }>(`SELECT pack_id FROM downloaded_packs ORDER BY 1`)).rows.map(
    (r) => r.pack_id,
  );
}

export interface UserCollectionState {
  archived: string[];
  hiddenInRegions: Array<{ region: string; species: string }>;
  seen: string[];
  targets: string[];
  /** The user's own rarity tiers; region null = everywhere. */
  tierOverrides?: Array<{ region: string | null; species: string; tier: string }>;
  /** Species added to a region's checklist by hand (regions/checklistAdditions.ts). */
  addedToRegions?: Array<{ region: string; species: string }>;
  /** Species added to a sea zone's checklist by hand, by the zone's name (names are unique). */
  addedToSeaZones?: Array<{ seaZone: string; species: string }>;
  /** Each species card's cover photo and crop, so a reimport brings back cards as they were
   *  arranged. The cover is found again by its original file's content hash, else its path in
   *  the library (Lifer writing tags into a managed file changes its hash). */
  cards?: SavedCard[];
  /** Species added from iNaturalist (Other Taxa), which a fresh catalog doesn't have: re-added
   *  from iNaturalist by their taxon id before a reimport matches photos to them. */
  otherTaxa?: SavedOtherTaxon[];
}

export interface SavedOtherTaxon {
  inatTaxonId: number;
  scientificName: string;
  commonName: string | null;
}

export interface SavedCard {
  species: string;
  coverFingerprint: string | null;
  /** The cover's original file, relative to the library folder. */
  coverPath: string | null;
  cropX: number | null;
  cropY: number | null;
  cropSize: number | null;
}

interface CollectionStateFile {
  version: 1;
  updatedAt: string;
  users: Record<string, UserCollectionState>;
  /** The offline packs this library's install had, so a fresh install opened on the library
   *  downloads them again by itself (packs belong to the install, not an account). */
  packs?: string[];
}

/** The library's record, if this library folder has one: an earlier Lifer install used it. The
 *  regions it had are null in a record from before they were kept. */
export function libraryRecord(dir: string = ORIGINALS_DIR): { packs: string[] | null } | null {
  const file = readStateFile(dir);
  return file ? { packs: file.packs ?? null } : null;
}

/** The saved state of this user in a record: theirs by email, or the only one in a one-user
 *  record on a one-user install (a desktop library, whose account is always local). */
async function savedFor(file: CollectionStateFile, userId: string): Promise<UserCollectionState | null> {
  const user = (await pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId])).rows[0];
  if (!user) return null;
  if (file.users[user.email]) return file.users[user.email];
  const entries = Object.values(file.users);
  if (entries.length !== 1) return null;
  const userCount = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`)).rows[0].n;
  return userCount === 1 ? entries[0] : null;
}

export function collectionStatePath(): string {
  return path.join(ORIGINALS_DIR, ".lifer", "collection-state.json");
}

function recordPathIn(dir: string): string {
  return path.join(dir, ".lifer", "collection-state.json");
}

/** This library's record, or another library folder's (an import of a second Lifer library). */
function readStateFile(dir: string = ORIGINALS_DIR): CollectionStateFile | null {
  try {
    const parsed = JSON.parse(readFileSync(recordPathIn(dir), "utf8")) as CollectionStateFile;
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
  const [archived, hidden, states, overrides, added, addedToSeaZones, cards, otherTaxa] = await Promise.all([
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
    pool.query<{ region: string | null; species: string; tier: string }>(
      `SELECT CASE WHEN o.region_id IS NULL THEN NULL ELSE ${REGION_KEY_SQL} END AS region, s.scientific_name AS species, o.tier
         FROM user_tier_overrides o JOIN species s ON s.id = o.species_id LEFT JOIN regions r ON r.id = o.region_id
        WHERE o.user_id = $1 ORDER BY 2, 1`,
      [userId],
    ),
    pool.query<{ region: string; species: string }>(
      `SELECT ${REGION_KEY_SQL} AS region, s.scientific_name AS species
         FROM region_species_user_added a JOIN regions r ON r.id = a.region_id JOIN species s ON s.id = a.species_id
        -- A list's additions come back with the list, not one iNaturalist lookup per species.
        WHERE a.user_id = $1 AND NOT a.via_list ORDER BY 1, 2`,
      [userId],
    ),
    pool.query<{ seaZone: string; species: string }>(
      `SELECT z.name AS "seaZone", s.scientific_name AS species
         FROM sea_zone_species_user_added a JOIN sea_zones z ON z.id = a.sea_zone_id JOIN species s ON s.id = a.species_id
        WHERE a.user_id = $1 ORDER BY 1, 2`,
      [userId],
    ),
    pool.query<{
      species: string;
      fingerprint: string | null;
      ref: string | null;
      card_crop_x: string | null;
      card_crop_y: string | null;
      card_crop_size: string | null;
    }>(
      `SELECT s.scientific_name AS species, c.fingerprint,
              (SELECT o.ref FROM originals o WHERE o.capture_id = c.id AND o.ref_type = 'path'
                ORDER BY (o.kind = 'jpeg') DESC LIMIT 1) AS ref,
              us.card_crop_x, us.card_crop_y, us.card_crop_size
         FROM user_species us
         JOIN species s ON s.id = us.species_id
         JOIN photos p ON p.id = us.cover_photo_id
         JOIN captures_all c ON c.id = p.capture_id
        WHERE us.user_id = $1 ORDER BY 1`,
      [userId],
    ),
    pool.query<{ inat_taxon_id: number; scientific_name: string; common_name: string | null }>(
      `SELECT s.inat_taxon_id, s.scientific_name, s.common_name FROM species s
        WHERE s.is_other_taxa AND s.inat_taxon_id IS NOT NULL AND (
          EXISTS (SELECT 1 FROM user_species us WHERE us.user_id = $1 AND us.species_id = s.id)
          OR EXISTS (SELECT 1 FROM captures_all c WHERE c.user_id = $1 AND c.species_id = s.id)
          OR EXISTS (SELECT 1 FROM region_species_user_added a WHERE a.user_id = $1 AND a.species_id = s.id AND NOT a.via_list)
          OR EXISTS (SELECT 1 FROM sea_zone_species_user_added a WHERE a.user_id = $1 AND a.species_id = s.id))
        ORDER BY 2`,
      [userId],
    ),
  ]);
  const relative = (ref: string | null) => {
    if (!ref) return null;
    const rel = path.relative(ORIGINALS_DIR, ref);
    return rel.startsWith("..") || path.isAbsolute(rel) ? null : rel.split(path.sep).join("/");
  };
  const num = (v: string | null) => (v == null ? null : Number(v));
  return {
    archived: archived.rows.map((r) => r.name),
    hiddenInRegions: hidden.rows,
    seen: states.rows.filter((r) => r.state === "seen").map((r) => r.name),
    targets: states.rows.filter((r) => r.is_target).map((r) => r.name),
    tierOverrides: overrides.rows,
    addedToRegions: added.rows,
    addedToSeaZones: addedToSeaZones.rows,
    cards: cards.rows.map((r) => ({
      species: r.species,
      coverFingerprint: r.fingerprint,
      coverPath: relative(r.ref),
      cropX: num(r.card_crop_x),
      cropY: num(r.card_crop_y),
      cropSize: num(r.card_crop_size),
    })),
    otherTaxa: otherTaxa.rows.map((r) => ({
      inatTaxonId: r.inat_taxon_id,
      scientificName: r.scientific_name,
      commonName: r.common_name,
    })),
  };
}

// Users a restore has been tried for since startup. New users are created after startup (first
// request or sign-up), so their first session check is the other moment to try. A restore that
// found none of the record's species (the catalog still loading on a first start) doesn't count
// as tried, so the next session check tries again.
const restoreTried = new Set<string>();

type RestoreResult = { restored: number; notFound: number };
// The record names species this catalog doesn't have at all: not installed yet.
const CATALOG_MISSING = "catalog-missing" as const;

const isEmpty = (s: UserCollectionState) =>
  s.archived.length +
    s.hiddenInRegions.length +
    s.seen.length +
    s.targets.length +
    (s.tierOverrides?.length ?? 0) +
    (s.addedToRegions?.length ?? 0) +
    (s.addedToSeaZones?.length ?? 0) ===
  0;

/** Writes this user's current state into the library's record. */
export async function saveCollectionState(userId: string): Promise<void> {
  const user = (await pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId])).rows[0];
  if (!user) return;
  const state = await currentCollectionState(userId);
  const packs = await downloadedPackIds();
  const file = readStateFile() ?? { version: 1 as const, updatedAt: "", users: {} };
  // Nothing to keep and nothing kept before: don't create a file just to say so.
  if (
    isEmpty(state) &&
    !state.cards?.length &&
    !state.otherTaxa?.length &&
    packs.length === 0 &&
    !file.users[user.email]
  )
    return;
  file.users[user.email] = state;
  // A fresh install has none yet; keep the old install's list for the setup screen to offer.
  if (packs.length > 0) file.packs = packs;
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
      saveCollectionState(userId).catch((err) =>
        log.warn(`[collection-state] couldn't save: ${(err as Error).message}`),
      );
    }, 2000),
  );
}

// Every route that changes this state. Matched after a successful response rather than wired
// into each route, so new routes in these families are covered too.
const STATE_ROUTES = [
  /^\/api\/species\/[^/]+\/(archive|seen|target|tier-override)$/,
  /^\/api\/archive\/bulk$/,
  /^\/api\/regions\/[^/]+\/species\/[^/]+\/hide$/,
  /^\/api\/regions\/hidden-species\/bulk$/,
  /^\/api\/regions\/[^/]+\/checklist-additions\/[^/]+$/,
  /^\/api\/sea-zones\/[^/]+\/checklist-additions\/[^/]+$/,
  // Hand imports and their removal (species/otherTaxa.ts) change checklist additions.
  /^\/api\/species\/other-taxa$/,
  /^\/api\/species\/[^/]+\/other-taxa$/,
  /^\/api\/imports\//,
  // Choosing a card's cover photo or moving its crop.
  /^\/api\/species\/[^/]+\/(cover|card-crop)$/,
  // Downloading or removing a pack changes what a reopened library should download again.
  /^\/api\/offline-packs\//,
];

/** Called from /auth/me: tries a restore the first time each user shows up after startup. */
export function tryRestoreCollectionStateOnce(userId: string): void {
  if (restoreTried.has(userId)) return;
  restoreTried.add(userId);
  tryRestore(userId)
    .then((outcome) => {
      if (outcome === CATALOG_MISSING) restoreTried.delete(userId);
    })
    .catch((err) => {
      restoreTried.delete(userId);
      log.warn(`[collection-state] couldn't restore: ${(err as Error).message}`);
    });
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
 *  or null when there was nothing to do (or the catalog isn't installed yet). */
export async function restoreCollectionState(userId: string): Promise<RestoreResult | null> {
  const outcome = await tryRestore(userId);
  return outcome === CATALOG_MISSING ? null : outcome;
}

async function tryRestore(userId: string): Promise<RestoreResult | typeof CATALOG_MISSING | null> {
  const file = readStateFile();
  if (!file) return null;
  const current = await currentCollectionState(userId);
  if (!isEmpty(current)) return null; // this install already has its own; the database wins
  const saved = await savedFor(file, userId);
  if (!saved || isEmpty(saved)) return null;
  return applySaved(userId, saved);
}

/** Adds everything in a saved state that this install doesn't have yet. Only adds: nothing here
 *  is removed or downgraded (a photographed species stays photographed), so it is safe to run on
 *  an install that already has state of its own, as when a second library is merged in. */
async function applySaved(userId: string, saved: UserCollectionState): Promise<RestoreResult | typeof CATALOG_MISSING> {
  const names = [
    ...new Set([
      ...saved.archived,
      ...saved.seen,
      ...saved.targets,
      ...saved.hiddenInRegions.map((h) => h.species),
      ...(saved.tierOverrides ?? []).map((o) => o.species),
      ...(saved.addedToRegions ?? []).map((a) => a.species),
      ...(saved.addedToSeaZones ?? []).map((a) => a.species),
    ]),
  ];
  const ids = await speciesIdsByName(names);
  if (ids.size === 0) return CATALOG_MISSING; // catalog not installed yet: try again later
  const regionRes = await pool.query<{ key: string; id: string }>(
    `SELECT ${REGION_KEY_SQL} AS key, r.id FROM regions r`,
  );
  const regionIds = new Map(regionRes.rows.map((r) => [r.key, r.id]));
  const zoneRes = await pool.query<{ name: string; id: string }>(`SELECT name, id FROM sea_zones`);
  const seaZoneIds = new Map(zoneRes.rows.map((z) => [z.name, z.id]));

  let restored = 0;
  let notFound = 0;
  await withTransaction(async (client) => {
    for (const name of saved.archived) {
      const id = ids.get(name);
      if (!id) {
        notFound++;
        continue;
      }
      await client.query(
        `INSERT INTO user_archived_species (user_id, species_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [userId, id],
      );
      restored++;
    }
    for (const h of saved.hiddenInRegions) {
      const id = ids.get(h.species);
      const regionId = regionIds.get(h.region);
      if (!id || !regionId) {
        notFound++;
        continue;
      }
      await client.query(
        `INSERT INTO region_species_hidden (user_id, region_id, species_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [userId, regionId, id],
      );
      restored++;
    }
    for (const name of saved.seen) {
      const id = ids.get(name);
      if (!id) {
        notFound++;
        continue;
      }
      // Never downgrades: a species you've since photographed stays collected.
      await client.query(
        `INSERT INTO user_species (user_id, species_id, state) VALUES ($1, $2, 'seen') ON CONFLICT (user_id, species_id) DO NOTHING`,
        [userId, id],
      );
      restored++;
    }
    for (const o of saved.tierOverrides ?? []) {
      const id = ids.get(o.species);
      const regionId = o.region == null ? null : regionIds.get(o.region);
      // A tier name this version doesn't know would fail the CHECK and abort the whole restore.
      if (!id || regionId === undefined || !TIER_ORDER.includes(o.tier as TierValue)) {
        notFound++;
        continue;
      }
      await client.query(
        `INSERT INTO user_tier_overrides (user_id, region_id, species_id, tier) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [userId, regionId, id, o.tier],
      );
      restored++;
    }
    for (const a of saved.addedToRegions ?? []) {
      const id = ids.get(a.species);
      const regionId = regionIds.get(a.region);
      if (!id || !regionId) {
        notFound++;
        continue;
      }
      await client.query(
        `INSERT INTO region_species_user_added (user_id, region_id, species_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [userId, regionId, id],
      );
      restored++;
    }
    // A backup can hold both a province and a country addition of one hand-added species.
    await foldInnerAdditions(client, userId);
    for (const a of saved.addedToSeaZones ?? []) {
      const id = ids.get(a.species);
      const seaZoneId = seaZoneIds.get(a.seaZone);
      if (!id || !seaZoneId) {
        notFound++;
        continue;
      }
      await client.query(
        `INSERT INTO sea_zone_species_user_added (user_id, sea_zone_id, species_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [userId, seaZoneId, id],
      );
      restored++;
    }
    for (const name of saved.targets) {
      const id = ids.get(name);
      if (!id) {
        notFound++;
        continue;
      }
      await client.query(
        `INSERT INTO user_species (user_id, species_id, is_target) VALUES ($1, $2, true) ON CONFLICT (user_id, species_id) DO UPDATE SET is_target = true`,
        [userId, id],
      );
      restored++;
    }
  });
  log.info(
    `[collection-state] Restored ${restored} archived, hidden, seen, target, tier and checklist entries from the library${notFound ? ` (${notFound} not in this catalog)` : ""}.`,
  );
  return { restored, notFound };
}

/** At startup, once the first-boot catalog load is over (index.ts runs this after
 *  seedCatalogIfEmpty): restore for users with no state of their own, and write a first record
 *  for users with state but no record. A user with no state is never saved, which could overwrite
 *  a record the restore couldn't apply yet (the catalog still installing, say); their next session
 *  check tries the restore again. */
export async function syncCollectionStateOnStartup(): Promise<void> {
  const users = (await pool.query<{ id: string }>(`SELECT id FROM users`)).rows;
  for (const { id } of users) {
    try {
      restoreTried.add(id);
      const outcome = await tryRestore(id);
      if (outcome === CATALOG_MISSING) {
        restoreTried.delete(id);
        continue;
      }
      if (outcome) continue;
      if (!isEmpty(await currentCollectionState(id))) await saveCollectionState(id);
    } catch (err) {
      log.warn(`[collection-state] ${(err as Error).message}`);
    }
  }
}

/** Brings back each saved card's cover and crop whose photo is in the library again: after a
 *  reimport, when the photos are back. The record is saved on every cover or crop change, so it
 *  is the latest arrangement and wins over the default crops a reimport gives new cards. */
export async function restoreCards(userId: string, dir: string = ORIGINALS_DIR, merging = false): Promise<number> {
  const file = readStateFile(dir);
  if (!file) return 0;
  const saved = await savedFor(file, userId);
  const cards = saved?.cards ?? [];
  if (cards.length === 0) return 0;
  const ids = await speciesIdsByName(cards.map((c) => c.species));
  let restored = 0;
  await withTransaction(async (client) => {
    for (const card of cards) {
      const speciesId = ids.get(card.species);
      if (!speciesId) continue;
      const absolute = card.coverPath ? path.join(dir, ...card.coverPath.split("/")) : null;
      // Merging a second library: a card whose cover this library already set from its own
      // photos keeps it.
      if (merging) {
        const own = await client.query(
          `SELECT 1 FROM user_species us JOIN photos p ON p.id = us.cover_photo_id
             JOIN originals o ON o.capture_id = p.capture_id
            WHERE us.user_id = $1 AND us.species_id = $2 AND left(o.ref, length($3)) <> $3`,
          [userId, speciesId, dir.endsWith(path.sep) ? dir : dir + path.sep],
        );
        if (own.rowCount) continue;
      }
      const cover = await client.query<{ photo_id: string }>(
        `SELECT c.current_photo_id AS photo_id FROM captures c
          WHERE c.user_id = $1 AND c.current_photo_id IS NOT NULL
            AND (c.fingerprint = $2 OR EXISTS (SELECT 1 FROM originals o WHERE o.capture_id = c.id AND o.ref = $3))
          ORDER BY (c.fingerprint = $2) DESC LIMIT 1`,
        [userId, card.coverFingerprint, absolute],
      );
      const photoId = cover.rows[0]?.photo_id;
      if (!photoId) continue;
      await client.query(
        `INSERT INTO user_species (user_id, species_id, cover_photo_id, card_crop_x, card_crop_y, card_crop_size)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, species_id) DO UPDATE SET cover_photo_id = EXCLUDED.cover_photo_id,
           card_crop_x = EXCLUDED.card_crop_x, card_crop_y = EXCLUDED.card_crop_y, card_crop_size = EXCLUDED.card_crop_size`,
        [userId, speciesId, photoId, card.cropX, card.cropY, card.cropSize],
      );
      restored++;
    }
  });
  if (restored) log.info(`[collection-state] Restored ${restored} card covers and crops from the library.`);
  return restored;
}

/** Re-adds the record's hand-added species from iNaturalist, so photos filed under them match
 *  again. Before the reimport walks the files. Best effort: offline, they stay unmatched and the
 *  review list offers them. */
export async function restoreOtherTaxa(userId: string, dir: string = ORIGINALS_DIR): Promise<number> {
  const file = readStateFile(dir);
  if (!file) return 0;
  const saved = await savedFor(file, userId);
  const wanted = saved?.otherTaxa ?? [];
  if (wanted.length === 0) return 0;
  const have = await pool.query<{ inat_taxon_id: number }>(
    `SELECT inat_taxon_id FROM species WHERE inat_taxon_id = ANY($1::int[])`,
    [wanted.map((t) => t.inatTaxonId)],
  );
  const present = new Set(have.rows.map((r) => r.inat_taxon_id));
  // Lazy: species/otherTaxaSpecies.ts pulls in enrichment and the photo store.
  const { resolveOrCreateOtherTaxaSpecies } = await import("../species/otherTaxaSpecies.js");
  let added = 0;
  for (const taxon of wanted) {
    if (present.has(taxon.inatTaxonId)) continue;
    try {
      await resolveOrCreateOtherTaxaSpecies(taxon.inatTaxonId);
      added++;
    } catch (err) {
      log.warn(`[collection-state] couldn't re-add ${taxon.scientificName}: ${(err as Error).message}`);
    }
  }
  if (added) log.info(`[collection-state] Re-added ${added} hand-added species from iNaturalist.`);
  return added;
}

/** After a reimport walks a Lifer library: everything its record holds that this install
 *  doesn't, added, then its card covers and crops. `dir` is the library's folder; another one
 *  than this install's own is merged without touching what this library already has. */
export async function mergeLibraryRecord(userId: string, dir: string = ORIGINALS_DIR): Promise<void> {
  const file = readStateFile(dir);
  if (!file) return;
  const saved = await savedFor(file, userId);
  if (!saved) return;
  if (!isEmpty(saved)) await applySaved(userId, saved);
  await restoreCards(userId, dir, path.resolve(dir) !== path.resolve(ORIGINALS_DIR));
}

/** Whether a folder holds a Lifer library (its record). */
export function isLiferLibrary(dir: string): boolean {
  return readStateFile(dir) !== null;
}
