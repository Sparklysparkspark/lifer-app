// One-off backfill for installs that downloaded packs before pack_species (migration 054)
// existed — populates it retroactively so the new delete/offload feature has real reference
// data to work with immediately, instead of only for packs downloaded from here on.
//
// Uses the pack INDEX's own scientificNames list (already fetched for every other pack-index
// consumer, no per-pack archive re-download needed) rather than re-extracting each pack's own
// tar.gz — cheaper, and sufficient: every species listed for a pack is marked
// provided_enrichment = true here, a deliberate over-attribution (we don't retroactively know
// which ONE of several already-downloaded packs actually wrote a shared species' file first)
// that stays safe under the "never delete something another pack might still need" rule the
// delete endpoint follows — a species backfilled as belonging to multiple still-downloaded
// packs simply won't be eligible for physical deletion until ALL of them are gone, which is
// the conservative direction to err in.
//
// A pack no longer present in the index at all (rotated out) is left with no backfilled
// rows for its own pack_id — the delete endpoint's own "unknown provenance -> assume still
// needed" rule (see its own comment) covers this gracefully rather than needing special
// handling here.
import { pool } from "../db.js";
import { fetchPackIndex } from "../offlinePacks/routes.js";

async function main() {
  const index = await fetchPackIndex();
  const byId = new Map(index.packs.map((p) => [p.id, p]));

  const downloadedRes = await pool.query<{ pack_id: string }>(`SELECT pack_id FROM downloaded_packs`);
  console.log(`[backfill-pack-species] ${downloadedRes.rows.length} downloaded pack(s) to backfill`);

  let backfilled = 0;
  let missingFromIndex = 0;
  let totalRows = 0;
  for (const { pack_id: packId } of downloadedRes.rows) {
    const entry = byId.get(packId);
    if (!entry) {
      missingFromIndex++;
      console.log(`[backfill-pack-species] ${packId}: no longer in the pack index, skipping (delete logic treats this conservatively)`);
      continue;
    }
    if (entry.scientificNames.length === 0) continue;

    const speciesRes = await pool.query<{ id: string }>(`SELECT id FROM species WHERE scientific_name = ANY($1)`, [
      entry.scientificNames,
    ]);
    if (speciesRes.rows.length === 0) continue;

    await pool.query(
      `INSERT INTO pack_species (pack_id, species_id, provided_enrichment)
       SELECT $1, unnest($2::uuid[]), true
       ON CONFLICT (pack_id, species_id) DO NOTHING`,
      [packId, speciesRes.rows.map((r) => r.id)],
    );
    totalRows += speciesRes.rows.length;
    backfilled++;
  }

  console.log(
    `[backfill-pack-species] done. ${backfilled} pack(s) backfilled (${totalRows} pack_species rows), ` +
      `${missingFromIndex} pack(s) no longer in the index.`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
