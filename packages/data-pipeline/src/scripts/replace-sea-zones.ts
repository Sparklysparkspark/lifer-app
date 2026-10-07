// Replaces every sea zone with the IHO Sea Areas' named seas (fetch-iho-sea-areas.ts) plus each
// country's part of the oceans (fetch-eez-iho.ts), and relinks regions to them. Zones not in the new set go with their species lists (sea_zone_species cascades) and this
// database's downloaded_packs rows for them; regions.nearby_sea_zone_ids is recomputed for every
// region. Safe to rerun: a zone whose name and shape haven't changed is left alone.
//
//   npm run replace-sea-zones -w data-pipeline             dry run: reports what would change, rolls back
//   npm run replace-sea-zones -w data-pipeline -- --apply  does it
// with DATABASE_URL set to the database to change.
//
// The new zones have no species until apps/api's compute-sea-zones.ts runs; see SCRIPTS.md for the
// steps after this one.
import { pool } from "../db.js";
import { fetchIhoSeaAreas } from "../fetch/fetch-iho-sea-areas.js";
import { fetchOceanEezZones } from "../fetch/fetch-eez-iho.js";
import { replaceSeaZones } from "../build/build-sea-zones.js";

const log = (m: string) => console.log(`[replace-sea-zones] ${m}`);

async function main() {
  const apply = process.argv.includes("--apply");
  const zones = [...(await fetchIhoSeaAreas()), ...(await fetchOceanEezZones())];
  const client = await pool.connect();
  // Says which database it's about to change: without DATABASE_URL, db.ts uses localhost:5432.
  const { host, port, database } = client as unknown as { host: string; port: number; database: string };
  log(`database ${database} at ${host}:${port}${apply ? "" : " (dry run)"}`);
  try {
    await client.query("BEGIN");
    const result = await replaceSeaZones(client, zones, log);
    log(`removed: ${result.removed.join(", ") || "none"}`);
    log(`inserted: ${result.inserted.join(", ") || "none"}`);
    log(`${result.speciesRowsRemoved} sea_zone_species row(s) removed with them`);
    if (result.downloadedPacksRemoved.length > 0)
      log(`downloaded_packs rows removed: ${result.downloadedPacksRemoved.join(", ")}`);
    if (apply) {
      await client.query("COMMIT");
      log(
        `done. ${result.inserted.length} zone(s) need their species computed: npx tsx src/scripts/compute-sea-zones-offline.ts --apply (from packages/data-pipeline)`,
      );
    } else {
      await client.query("ROLLBACK");
      log("dry run, nothing changed; rerun with --apply");
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
