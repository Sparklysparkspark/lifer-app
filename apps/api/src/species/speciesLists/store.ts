// Database side of lists: one page of species written set-based in one transaction with the
// cursor, so a crash resumes at the next page and a re-run adds nothing twice; and removing a list.
import type { PoolClient } from "pg";
import { pool, withTransaction } from "@lifer/core/db.js";
import { log } from "@lifer/core/lib/log.js";
import { deleteUnreferencedFiles } from "../../offlinePacks/remove.js";
import { addToList } from "../../collection/targetLists.js";
import type { ListSpecies } from "./inat.js";

export type ListStatus = "queued" | "running" | "paused" | "offline" | "done" | "failed";

export interface SpeciesListRow {
  id: string;
  user_id: string;
  name: string;
  inat_taxon_id: number;
  taxon_name: string;
  taxon_rank: string | null;
  inat_place_id: number;
  place_name: string;
  region_id: string;
  native_only: boolean;
  size_estimate: number | null;
  added_count: number;
  status: ListStatus;
  last_error: string | null;
  next_page: number;
  next_batch_at: Date | null;
  hidden: boolean;
  target_list_id: string | null;
  target_photographed: boolean;
  created_at: Date;
  updated_at: Date;
  last_refreshed_at: Date | null;
}

// The species each iNaturalist taxon is in this install: a single catalog species with that iNat id
// wins, else an Other Taxa row with it; then the same by exact scientific name. An id or name
// several catalog species share is ambiguous and never guessed.
const RESOLVE_SQL = `
  SELECT p.taxon_id, COALESCE(
    (SELECT CASE WHEN count(*) FILTER (WHERE NOT s.is_other_taxa) = 1
                 THEN (array_agg(s.id) FILTER (WHERE NOT s.is_other_taxa))[1]
                 ELSE (array_agg(s.id ORDER BY s.id) FILTER (WHERE s.is_other_taxa))[1] END
       FROM species s WHERE s.inat_taxon_id = p.taxon_id),
    (SELECT CASE WHEN count(*) FILTER (WHERE NOT s.is_other_taxa) = 1
                 THEN (array_agg(s.id) FILTER (WHERE NOT s.is_other_taxa))[1]
                 ELSE (array_agg(s.id ORDER BY s.id) FILTER (WHERE s.is_other_taxa))[1] END
       FROM species s WHERE s.scientific_name = p.name)
  ) AS species_id
  FROM unnest($1::int[], $2::text[]) AS p(taxon_id, name)`;

async function resolveSpecies(db: PoolClient, species: ListSpecies[]): Promise<Map<number, string>> {
  const res = await db.query<{ taxon_id: number; species_id: string | null }>(RESOLVE_SQL, [
    species.map((s) => s.taxonId),
    species.map((s) => s.scientificName),
  ]);
  return new Map(res.rows.filter((r) => r.species_id).map((r) => [r.taxon_id, r.species_id!]));
}

/** Writes one page: new Other Taxa rows for unknown taxa (synthetic GBIF key -taxon_id, as a hand
 *  add of an unmatched taxon), members, and the list's checklist additions; then the cursor. False
 *  when the list is gone or no longer running (paused, removed), so the caller stops. */
export async function savePage(
  listId: string,
  species: ListSpecies[],
  nextPage: number,
  total: number,
  last: boolean,
): Promise<boolean> {
  return withTransaction(async (db) => {
    const list = await db.query<{
      user_id: string;
      region_id: string;
      status: string;
      target_list_id: string | null;
      target_photographed: boolean;
    }>(
      `SELECT user_id, region_id, status, target_list_id, target_photographed FROM species_lists WHERE id = $1 FOR UPDATE`,
      [listId],
    );
    const row = list.rows[0];
    if (!row || row.status !== "running") return false;

    if (species.length > 0) {
      const known = await resolveSpecies(db, species);
      const missing = species.filter((s) => !known.has(s.taxonId));
      const created = await db.query<{ inat_taxon_id: number }>(
        `INSERT INTO species (gbif_key, scientific_name, common_name, taxon_class, is_other_taxa, inat_taxon_id,
                              inat_iconic_taxon, reference_photo, reference_credit, reference_license)
         SELECT -p.taxon_id, p.name, p.common, lower(COALESCE(p.iconic, 'other')), true, p.taxon_id,
                p.iconic, p.photo, p.credit, p.license
           FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
                AS p(taxon_id, name, common, iconic, photo, credit, license)
         ON CONFLICT (gbif_key) DO NOTHING
         RETURNING inat_taxon_id`,
        [
          missing.map((s) => s.taxonId),
          missing.map((s) => s.scientificName),
          missing.map((s) => s.commonName),
          missing.map((s) => s.iconicTaxon),
          missing.map((s) => s.photo?.url ?? null),
          missing.map((s) => s.photo?.credit ?? null),
          missing.map((s) => s.photo?.license ?? null),
        ],
      );
      const createdIds = new Set(created.rows.map((r) => r.inat_taxon_id));
      const ids = createdIds.size > 0 ? await resolveSpecies(db, species) : known;
      // One member per species, even when two taxa land on one row.
      const bySpecies = new Map<string, ListSpecies>();
      for (const s of species) {
        const id = ids.get(s.taxonId);
        if (id && !bySpecies.has(id)) bySpecies.set(id, s);
      }
      const members = [...bySpecies.entries()];
      await db.query(
        `INSERT INTO species_list_members (list_id, species_id, inat_taxon_id, inat_count, establishment_means, created_species)
         SELECT $1, m.species_id, m.taxon_id, m.cnt, m.means, m.created
           FROM unnest($2::uuid[], $3::int[], $4::int[], $5::text[], $6::boolean[]) AS m(species_id, taxon_id, cnt, means, created)
         ON CONFLICT (list_id, species_id) DO UPDATE SET
           inat_count = EXCLUDED.inat_count, establishment_means = EXCLUDED.establishment_means,
           created_species = species_list_members.created_species OR EXCLUDED.created_species, last_seen_at = now()`,
        [
          listId,
          members.map(([id]) => id),
          members.map(([, s]) => s.taxonId),
          members.map(([, s]) => s.count),
          members.map(([, s]) => s.establishmentMeans),
          members.map(([, s]) => createdIds.has(s.taxonId)),
        ],
      );
      // A hand addition already there stays a hand one.
      await db.query(
        `INSERT INTO region_species_user_added (user_id, region_id, species_id, via_list)
         SELECT $1, $2, unnest($3::uuid[]), true
         ON CONFLICT DO NOTHING`,
        [row.user_id, row.region_id, members.map(([id]) => id)],
      );
      if (row.target_list_id)
        await targetSpecies(
          db,
          row.user_id,
          row.target_list_id,
          members.map(([id]) => id),
          row.target_photographed,
        );
    }

    await db.query(
      `UPDATE species_lists SET
         next_page = $2, size_estimate = $3,
         added_count = (SELECT count(*) FROM species_list_members WHERE list_id = $1),
         status = CASE WHEN $4 THEN 'done' ELSE status END,
         last_refreshed_at = CASE WHEN $4 THEN now() ELSE last_refreshed_at END,
         next_batch_at = NULL, last_error = NULL
       WHERE id = $1`,
      [listId, nextPage, total, last],
    );
    return true;
  });
}

/** Puts species on a target list, leaving photographed ones off unless `photographed`. */
export async function targetSpecies(
  db: PoolClient,
  userId: string,
  targetListId: string,
  speciesIds: string[],
  photographed: boolean,
): Promise<string[]> {
  const open = photographed
    ? speciesIds
    : (
        await db.query<{ id: string }>(
          `SELECT t.id FROM unnest($1::uuid[]) AS t(id)
            WHERE NOT EXISTS (SELECT 1 FROM user_species us
                               WHERE us.user_id = $2 AND us.species_id = t.id AND us.state = 'collected')`,
          [speciesIds, userId],
        )
      ).rows.map((r) => r.id);
  return addToList(db, userId, targetListId, open);
}

/** Removes a list. Its checklist additions go, except where the user photographed or marked the
 *  species (they become hand additions) or another of their lists for the region holds it. Species
 *  rows the list created go too once nothing references them. */
export async function deleteList(
  listId: string,
  userId: string,
): Promise<{ removedSpecies: number; kept: number } | null> {
  const outcome = await withTransaction(async (db) => {
    const list = await db.query<{ region_id: string }>(
      `SELECT region_id FROM species_lists WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [listId, userId],
    );
    if (!list.rows[0]) return null;
    const regionId = list.rows[0].region_id;
    const kept = await db.query(
      `UPDATE region_species_user_added a SET via_list = false
         FROM species_list_members m
        WHERE m.list_id = $1 AND a.species_id = m.species_id AND a.user_id = $2 AND a.region_id = $3 AND a.via_list
          AND (EXISTS (SELECT 1 FROM user_species us WHERE us.user_id = $2 AND us.species_id = m.species_id)
               OR EXISTS (SELECT 1 FROM captures_all c WHERE c.user_id = $2 AND (c.species_id = m.species_id
                    OR EXISTS (SELECT 1 FROM capture_species cs WHERE cs.capture_id = c.id AND cs.species_id = m.species_id))))`,
      [listId, userId, regionId],
    );
    await db.query(
      `DELETE FROM region_species_user_added a
        USING species_list_members m
        WHERE m.list_id = $1 AND a.species_id = m.species_id AND a.user_id = $2 AND a.region_id = $3 AND a.via_list
          AND NOT EXISTS (SELECT 1 FROM species_lists l JOIN species_list_members o ON o.list_id = l.id
                           WHERE l.id <> $1 AND l.user_id = $2 AND l.region_id = $3 AND o.species_id = m.species_id)`,
      [listId, userId, regionId],
    );
    const created = await db.query<{ species_id: string }>(
      `SELECT species_id FROM species_list_members WHERE list_id = $1 AND created_species`,
      [listId],
    );
    await db.query(`DELETE FROM species_lists WHERE id = $1`, [listId]);
    const dropped = await dropUnreferencedSpecies(
      db,
      created.rows.map((r) => r.species_id),
    );
    return { removedSpecies: dropped.ids.length, kept: kept.rowCount ?? 0, files: dropped.files };
  });
  if (!outcome) return null;
  // After the commit, and only files no row points at any more.
  await deleteUnreferencedFiles(outcome.files);
  return { removedSpecies: outcome.removedSpecies, kept: outcome.kept };
}

// Other Taxa rows nobody uses: no list, checklist addition, mark, archive, tier override or photo.
async function dropUnreferencedSpecies(db: PoolClient, ids: string[]): Promise<{ ids: string[]; files: string[] }> {
  if (ids.length === 0) return { ids: [], files: [] };
  const free = await db.query<{ id: string }>(
    `SELECT s.id FROM species s
      WHERE s.id = ANY($1::uuid[]) AND s.is_other_taxa
        AND NOT EXISTS (SELECT 1 FROM species_list_members m WHERE m.species_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM region_species_user_added a WHERE a.species_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM sea_zone_species_user_added a WHERE a.species_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM user_species us WHERE us.species_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM user_archived_species ua WHERE ua.species_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM user_tier_overrides o WHERE o.species_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM captures_all c WHERE c.species_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM capture_species cs WHERE cs.species_id = s.id)`,
    [ids],
  );
  const freeIds = free.rows.map((r) => r.id);
  if (freeIds.length === 0) return { ids: [], files: [] };
  const files = await db.query<{ p: string }>(
    `SELECT p FROM species s, unnest(ARRAY[s.reference_display_path, s.reference_thumb_path]) AS p
      WHERE s.id = ANY($1::uuid[]) AND p IS NOT NULL
     UNION ALL
     SELECT p FROM species_reference_photos srp, unnest(ARRAY[srp.display_path, srp.thumb_path]) AS p
      WHERE srp.species_id = ANY($1::uuid[]) AND p IS NOT NULL`,
    [freeIds],
  );
  await db.query("SAVEPOINT drop_species");
  try {
    await db.query(`DELETE FROM species WHERE id = ANY($1::uuid[])`, [freeIds]);
    return { ids: freeIds, files: files.rows.map((r) => r.p) };
  } catch (err) {
    // Something else still points at one of them: the rows stay, harmless and unlisted.
    await db.query("ROLLBACK TO SAVEPOINT drop_species");
    log.warn({ err }, "List species still referenced elsewhere: list removed, species rows kept");
    return { ids: [], files: [] };
  }
}

export async function listsForUser(userId: string): Promise<(SpeciesListRow & { photos_ready: number })[]> {
  const res = await pool.query<SpeciesListRow & { photos_ready: number }>(
    `SELECT l.*,
            (SELECT count(*)::int FROM species_list_members m JOIN species s ON s.id = m.species_id
              WHERE m.list_id = l.id AND s.reference_display_path IS NOT NULL) AS photos_ready
       FROM species_lists l WHERE l.user_id = $1 ORDER BY l.created_at`,
    [userId],
  );
  return res.rows;
}

export async function listForUser(id: string, userId: string) {
  return (await listsForUser(userId)).find((l) => l.id === id) ?? null;
}
