// Applies species_merges: duplicate catalog species (one species under an old and a current
// name) folded into the surviving entry. Runs inside a catalog update's transaction and on the
// catalog database itself.
//
// For each old entry this install still has, in order:
// 1. The survivor keeps its own data and takes the old entry's only where it has none (a common
//    name, an eBird code, a checklist row, a gallery).
// 2. Everything a user made moves over: captures, originals, collected or seen state (combined
//    when both entries have it), covers, targets, archived and hidden marks.
// 3. The old name becomes a synonym of the survivor, so keyword tags and search still find it.
// 4. The old entry is deleted; its leftover catalog rows (the survivor already had them) cascade.
//
// Chains resolve to their end (A merged into B, later B into C: A goes straight to C). The caller
// holds lockReferenceData and owns the transaction.
import type { PoolClient } from "pg";

export interface SpeciesMergeResult {
  merged: number;
  /** Captures whose species changed, for re-syncing their XMP sidecars after commit. */
  captures: Array<{ userId: string; captureId: string }>;
}

// Catalog tables with one row per species (or per species and one other key): the survivor's own
// row wins, the old entry's is copied only when the survivor has none. `keys` are the other key
// columns besides species_id.
const COPY_WHEN_MISSING: Array<{ table: string; keys: string[] }> = [
  { table: "species_traits", keys: [] },
  { table: "species_rarity", keys: [] },
  { table: "species_reference_embeddings", keys: [] },
  { table: "species_text_embeddings", keys: [] },
  { table: "id_model_reference_embeddings", keys: [] },
  { table: "id_model_text_embeddings", keys: [] },
  { table: "region_species", keys: ["region_id"] },
  { table: "sea_zone_species", keys: ["sea_zone_id"] },
  { table: "species_nonnative_countries", keys: ["country_iso3"] },
  { table: "region_species_manual_overrides", keys: ["region_id"] },
  { table: "pack_species", keys: ["pack_id"] },
  // Per-user marks: the survivor gets the mark if either entry had it.
  { table: "user_archived_species", keys: ["user_id"] },
  { table: "region_species_hidden", keys: ["user_id", "region_id"] },
  { table: "user_tier_overrides", keys: ["user_id", "region_id"] },
];

// Filled on the survivor only when it has no value of its own.
const SPECIES_FILL_COLUMNS = [
  "common_name",
  "ebird_code",
  "inat_taxon_id",
  "family",
  "taxon_order",
  "habitat_description",
  "aba_code",
  "inat_iconic_taxon",
  "iucn_status",
  "wikipedia_title",
  "commons_image",
];

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

async function existingColumns(client: PoolClient, table: string): Promise<string[] | null> {
  const res = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1 AND is_generated = 'NEVER'
     ORDER BY ordinal_position`,
    [table],
  );
  return res.rows.length > 0 ? res.rows.map((r) => r.column_name) : null;
}

/** Resolves pending merges into temp table `pending_species_merges (old_id, new_id)`: chains
 *  followed to their end, and only pairs where both entries exist on this install. */
async function resolvePending(client: PoolClient): Promise<number> {
  await client.query(`DROP TABLE IF EXISTS pending_species_merges`);
  const res = await client.query(`
    CREATE TEMP TABLE pending_species_merges ON COMMIT DROP AS
    WITH RECURSIVE chain AS (
      SELECT m.old_species_id AS old_id, m.new_species_id AS new_id, 1 AS depth FROM species_merges m
      UNION ALL
      SELECT c.old_id, m.new_species_id, c.depth + 1
      FROM chain c JOIN species_merges m ON m.old_species_id = c.new_id
      WHERE c.depth < 20 AND m.new_species_id <> c.old_id
    ),
    final AS (SELECT DISTINCT ON (old_id) old_id, new_id FROM chain ORDER BY old_id, depth DESC)
    SELECT f.old_id, f.new_id
    FROM final f
    WHERE f.old_id <> f.new_id
      AND EXISTS (SELECT 1 FROM species WHERE id = f.old_id)
      AND EXISTS (SELECT 1 FROM species WHERE id = f.new_id)`);
  return res.rowCount ?? 0;
}

async function fillSurvivor(client: PoolClient): Promise<void> {
  const cols = new Set(await existingColumns(client, "species"));
  const fills = SPECIES_FILL_COLUMNS.filter((c) => cols.has(c)).map((c) => `${ident(c)} = COALESCE(n.${ident(c)}, o.${ident(c)})`);
  // The old entry's common name stays findable as an alias when the survivor's differs.
  if (cols.has("common_name_aliases")) {
    fills.push(`common_name_aliases = CASE
      WHEN o.common_name IS NOT NULL AND n.common_name IS NOT NULL AND lower(o.common_name) <> lower(n.common_name)
        AND NOT (lower(o.common_name) = ANY (SELECT lower(a) FROM unnest(COALESCE(n.common_name_aliases, '{}')) a))
      THEN array_append(COALESCE(n.common_name_aliases, '{}'), o.common_name)
      ELSE n.common_name_aliases END`);
  }
  // DISTINCT ON: with two old entries for one survivor, the one with the most to give fills it.
  await client.query(`
    UPDATE species n SET ${fills.join(", ")}
    FROM (
      SELECT DISTINCT ON (p.new_id) p.new_id, s.*
      FROM pending_species_merges p JOIN species s ON s.id = p.old_id
      ORDER BY p.new_id, (s.common_name IS NULL), (s.ebird_code IS NULL), s.scientific_name
    ) o
    WHERE n.id = o.new_id`);

  // The main reference photo moves as a set (photo, credit, license, focal point, cached files).
  const photoCols = ["reference_photo", "reference_credit", "reference_license", "reference_focal_x", "reference_focal_y", "reference_display_path", "reference_thumb_path"].filter((c) => cols.has(c));
  await client.query(`
    UPDATE species n SET ${photoCols.map((c) => `${ident(c)} = o.${ident(c)}`).join(", ")}
    FROM (
      SELECT DISTINCT ON (p.new_id) p.new_id, s.*
      FROM pending_species_merges p JOIN species s ON s.id = p.old_id
      WHERE s.reference_photo IS NOT NULL
      ORDER BY p.new_id, s.scientific_name
    ) o
    WHERE n.id = o.new_id AND n.reference_photo IS NULL`);

  // Description and its credit move together too.
  const descCols = ["description", "description_credit", "description_source_url"].filter((c) => cols.has(c));
  if (descCols.includes("description")) {
    await client.query(`
      UPDATE species n SET ${descCols.map((c) => `${ident(c)} = o.${ident(c)}`).join(", ")}
      FROM (
        SELECT DISTINCT ON (p.new_id) p.new_id, s.*
        FROM pending_species_merges p JOIN species s ON s.id = p.old_id
        WHERE s.description IS NOT NULL
        ORDER BY p.new_id, s.scientific_name
      ) o
      WHERE n.id = o.new_id AND n.description IS NULL`);
  }
}

async function moveSynonyms(client: PoolClient): Promise<void> {
  const hasSource = (await existingColumns(client, "species_synonyms"))?.includes("source") ?? false;
  await client.query(`
    UPDATE species_synonyms ss SET species_id = p.new_id
    FROM pending_species_merges p WHERE ss.species_id = p.old_id`);
  // A synonym that is just the survivor's own name adds nothing.
  await client.query(`
    DELETE FROM species_synonyms ss USING pending_species_merges p, species n
    WHERE ss.species_id = p.new_id AND n.id = p.new_id AND lower(ss.synonym_name) = lower(n.scientific_name)`);
  await client.query(`
    INSERT INTO species_synonyms (species_id, synonym_name${hasSource ? ", source" : ""})
    SELECT p.new_id, o.scientific_name${hasSource ? ", 'merge'" : ""}
    FROM pending_species_merges p JOIN species o ON o.id = p.old_id JOIN species n ON n.id = p.new_id
    WHERE lower(o.scientific_name) <> lower(n.scientific_name)
    ON CONFLICT (synonym_name) DO UPDATE SET species_id = EXCLUDED.species_id`);
}

async function mergeUserSpecies(client: PoolClient): Promise<void> {
  // The survivor's own row and every old entry's row, per user, combined into one: collected
  // beats seen, the earliest first-collected date and best quality win, a cover (with its crop)
  // comes from the survivor first, and a flag set on either entry stays set.
  await client.query(`
    WITH src AS (
      SELECT u.*, p.new_id, 0 AS rank FROM user_species u JOIN pending_species_merges p ON p.old_id = u.species_id
      UNION ALL
      SELECT u.*, u.species_id AS new_id, -1 AS rank FROM user_species u
      WHERE u.species_id IN (SELECT new_id FROM pending_species_merges)
    ),
    cover AS (
      SELECT DISTINCT ON (user_id, new_id) user_id, new_id, cover_photo_id, card_crop_x, card_crop_y, card_crop_size
      FROM src ORDER BY user_id, new_id, (cover_photo_id IS NULL), rank, (state = 'collected') DESC NULLS LAST
    ),
    agg AS (
      SELECT user_id, new_id,
        CASE WHEN bool_or(state = 'collected') THEN 'collected' WHEN bool_or(state = 'seen') THEN 'seen' END AS state,
        min(first_collected) AS first_collected,
        max(best_quality) AS best_quality,
        bool_or(COALESCE(was_ghost_when_collected, false)) AS was_ghost_when_collected,
        bool_or(COALESCE(was_lost_when_collected, false)) AS was_lost_when_collected,
        bool_or(COALESCE(is_target, false)) AS is_target
      FROM src GROUP BY user_id, new_id
    )
    INSERT INTO user_species (user_id, species_id, state, cover_photo_id, first_collected, best_quality,
                              card_crop_x, card_crop_y, card_crop_size, was_ghost_when_collected, was_lost_when_collected, is_target)
    SELECT a.user_id, a.new_id, a.state, c.cover_photo_id, a.first_collected, a.best_quality,
           c.card_crop_x, c.card_crop_y, c.card_crop_size, a.was_ghost_when_collected, a.was_lost_when_collected, a.is_target
    FROM agg a JOIN cover c USING (user_id, new_id)
    ON CONFLICT (user_id, species_id) DO UPDATE SET
      state = EXCLUDED.state,
      cover_photo_id = EXCLUDED.cover_photo_id,
      first_collected = EXCLUDED.first_collected,
      best_quality = EXCLUDED.best_quality,
      card_crop_x = EXCLUDED.card_crop_x,
      card_crop_y = EXCLUDED.card_crop_y,
      card_crop_size = EXCLUDED.card_crop_size,
      was_ghost_when_collected = EXCLUDED.was_ghost_when_collected,
      was_lost_when_collected = EXCLUDED.was_lost_when_collected,
      is_target = EXCLUDED.is_target`);
  await client.query(`DELETE FROM user_species u USING pending_species_merges p WHERE u.species_id = p.old_id`);
}

async function moveCaptures(client: PoolClient): Promise<Array<{ userId: string; captureId: string }>> {
  const moved = await client.query<{ user_id: string; id: string }>(`
    UPDATE captures_all c SET species_id = p.new_id
    FROM pending_species_merges p WHERE c.species_id = p.old_id
    RETURNING c.user_id, c.id`);
  await client.query(`UPDATE originals o SET species_id = p.new_id FROM pending_species_merges p WHERE o.species_id = p.old_id`);
  if (await existingColumns(client, "capture_species")) {
    await client.query(`
      INSERT INTO capture_species (capture_id, species_id)
      SELECT cs.capture_id, p.new_id FROM capture_species cs JOIN pending_species_merges p ON p.old_id = cs.species_id
      ON CONFLICT DO NOTHING`);
  }
  return moved.rows.map((r) => ({ userId: r.user_id, captureId: r.id }));
}

async function copyCatalogRows(client: PoolClient): Promise<void> {
  for (const { table, keys } of COPY_WHEN_MISSING) {
    const cols = await existingColumns(client, table);
    if (!cols) continue;
    const select = cols.map((c) => (c === "species_id" ? "p.new_id" : `t.${ident(c)}`));
    const distinct = ["p.new_id", ...keys.map((k) => `t.${ident(k)}`)].join(", ");
    await client.query(`
      INSERT INTO ${ident(table)} (${cols.map(ident).join(", ")})
      SELECT DISTINCT ON (${distinct}) ${select.join(", ")}
      FROM ${ident(table)} t JOIN pending_species_merges p ON p.old_id = t.species_id
      ORDER BY ${distinct}
      ON CONFLICT DO NOTHING`);
  }

  // Hotspot clusters have no unique key: a region's clusters move only when the survivor has none there.
  if (await existingColumns(client, "region_species_hotspots")) {
    await client.query(`
      UPDATE region_species_hotspots h SET species_id = p.new_id
      FROM pending_species_merges p
      WHERE h.species_id = p.old_id
        AND NOT EXISTS (SELECT 1 FROM region_species_hotspots x WHERE x.species_id = p.new_id AND x.region_id = h.region_id)`);
  }

  // A gallery moves only to a survivor without one, and its photos' vectors go with it. With
  // several old entries, only the largest gallery moves, so two copies of one URL can't collide.
  await client.query(`
    WITH donor AS (
      SELECT DISTINCT ON (p.new_id) p.new_id, p.old_id
      FROM pending_species_merges p
      JOIN (SELECT species_id, count(*) AS n FROM species_reference_photos GROUP BY species_id) c ON c.species_id = p.old_id
      WHERE NOT EXISTS (SELECT 1 FROM species_reference_photos x WHERE x.species_id = p.new_id)
      ORDER BY p.new_id, c.n DESC, p.old_id
    ),
    moving AS (
      SELECT ph.id, d.new_id FROM species_reference_photos ph JOIN donor d ON d.old_id = ph.species_id
    ),
    photos AS (
      UPDATE species_reference_photos ph SET species_id = m.new_id FROM moving m WHERE ph.id = m.id
      RETURNING ph.id, ph.species_id
    ),
    g1 AS (
      UPDATE species_reference_gallery_embeddings g SET species_id = photos.species_id FROM photos WHERE g.reference_photo_id = photos.id
      RETURNING 1
    )
    SELECT count(*) FROM photos`);
  if (await existingColumns(client, "id_model_gallery_embeddings")) {
    await client.query(`
      UPDATE id_model_gallery_embeddings g SET species_id = ph.species_id
      FROM species_reference_photos ph
      WHERE g.reference_photo_id = ph.id AND g.species_id <> ph.species_id`);
  }
}

/** Applies every pending merge. Returns how many old entries were folded in, and the captures
 *  that moved (their XMP sidecars name the species). */
export async function applySpeciesMerges(client: PoolClient): Promise<SpeciesMergeResult> {
  if (!(await existingColumns(client, "species_merges"))) return { merged: 0, captures: [] };
  const pending = await resolvePending(client);
  if (pending === 0) return { merged: 0, captures: [] };

  await fillSurvivor(client);
  await moveSynonyms(client);
  await copyCatalogRows(client);
  await mergeUserSpecies(client);
  const captures = await moveCaptures(client);

  // Earlier merges into an entry merged now point on to the survivor, so deleting the entry
  // doesn't cascade them away and a later seed still carries the whole chain.
  await client.query(`
    UPDATE species_merges m SET new_species_id = p.new_id
    FROM pending_species_merges p WHERE m.new_species_id = p.old_id AND m.old_species_id <> p.new_id`);
  const deleted = await client.query(`DELETE FROM species s USING pending_species_merges p WHERE s.id = p.old_id`);
  return { merged: deleted.rowCount ?? 0, captures };
}
