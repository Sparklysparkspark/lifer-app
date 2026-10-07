// Folds duplicate catalog species (the same species under an old and a current name) into one, on
// the catalog database. Reads a reviewed list, records each pair in species_merges (migration 113)
// and applies it with applySpeciesMerges, the same code a catalog update runs on every install, so
// installs repeat exactly what happened here once the next seed is published.
//
// The list is a TSV with a header: old_species_id, old_name, new_species_id, new_name, reason.
// A row is skipped unless both ids still exist under those exact names, so a list built before a
// rename or a rebuild can't merge the wrong pair.
//
// Usage (from packages/data-pipeline):
//   npx tsx src/scripts/merge-duplicate-species.ts                  (preview, changes nothing)
//   npx tsx src/scripts/merge-duplicate-species.ts --apply
//   npx tsx src/scripts/merge-duplicate-species.ts --list=/path/to/other.tsv
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "@lifer/core/db.js";
import { lockReferenceData } from "@lifer/core/lib/referenceDataLock.js";
import { applySpeciesMerges } from "@lifer/core/species/speciesMerges.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LIST = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "data-pipeline",
  "data",
  "reference",
  "species-merges.tsv",
);

interface Row {
  oldId: string;
  oldName: string;
  newId: string;
  newName: string;
}

function readList(file: string): Row[] {
  const [header, ...lines] = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim());
  const cols = header.split("\t");
  const at = (name: string) => {
    const i = cols.indexOf(name);
    if (i < 0) throw new Error(`${file} has no ${name} column`);
    return i;
  };
  const [o, on, n, nn] = [at("old_species_id"), at("old_name"), at("new_species_id"), at("new_name")];
  return lines.map((l) => {
    const f = l.split("\t");
    return { oldId: f[o], oldName: f[on], newId: f[n], newName: f[nn] };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const list = args.find((a) => a.startsWith("--list="))?.slice("--list=".length) ?? DEFAULT_LIST;
  const rows = readList(list);
  console.log(`[merge-duplicate-species] ${rows.length} pairs in ${list}`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockReferenceData(client);
    const valid = await client.query<{ old_id: string; new_id: string; old_name: string }>(
      `SELECT l.old_id, l.new_id, o.scientific_name AS old_name
       FROM unnest($1::uuid[], $2::text[], $3::uuid[], $4::text[]) AS l(old_id, old_name, new_id, new_name)
       JOIN species o ON o.id = l.old_id AND o.scientific_name = l.old_name
       JOIN species n ON n.id = l.new_id AND n.scientific_name = l.new_name`,
      [rows.map((r) => r.oldId), rows.map((r) => r.oldName), rows.map((r) => r.newId), rows.map((r) => r.newName)],
    );
    console.log(
      `[merge-duplicate-species] ${valid.rows.length} still match the catalog (the rest were already merged or renamed)`,
    );

    const impact = await client.query<{ regions: string; captures: string; users: string }>(
      `SELECT (SELECT count(*) FROM region_species WHERE species_id = ANY($1)) AS regions,
              (SELECT count(*) FROM captures_all WHERE species_id = ANY($1)) AS captures,
              (SELECT count(*) FROM user_species WHERE species_id = ANY($1)) AS users`,
      [valid.rows.map((r) => r.old_id)],
    );
    const i = impact.rows[0];
    console.log(
      `[merge-duplicate-species] old entries carry ${i.regions} checklist rows, ${i.captures} captures, ${i.users} collected/seen marks`,
    );

    await client.query(
      `INSERT INTO species_merges (old_species_id, new_species_id, old_scientific_name)
       SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[])
       ON CONFLICT (old_species_id) DO UPDATE SET new_species_id = EXCLUDED.new_species_id`,
      [valid.rows.map((r) => r.old_id), valid.rows.map((r) => r.new_id), valid.rows.map((r) => r.old_name)],
    );
    const result = await applySpeciesMerges(client);
    const left = await client.query<{ n: string }>(`SELECT count(*) AS n FROM species`);
    console.log(`[merge-duplicate-species] merged ${result.merged} species, ${left.rows[0].n} remain in the catalog`);

    if (apply) {
      await client.query("COMMIT");
      console.log("[merge-duplicate-species] applied");
    } else {
      await client.query("ROLLBACK");
      console.log("[merge-duplicate-species] preview only, nothing changed (pass --apply to keep it)");
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
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
