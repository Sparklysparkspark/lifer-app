// Nests provinces under their vernacular groups and moves disconnected ones under their continent
// (regions/vernacular.ts). Part of the refresh's regions stage; run on its own to preview.
//
// Usage (from packages/data-pipeline):
//   npx tsx src/scripts/sync-vernacular-regions.ts            (preview, nothing written)
//   npx tsx src/scripts/sync-vernacular-regions.ts --apply
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "@lifer/core/db.js";
import { syncVernacularRegions, type VernacularSyncResult } from "../regions/vernacular.js";

export function describeVernacularSync(r: VernacularSyncResult, apply: boolean): string[] {
  const lines = [
    `[vernacular] ${r.countries} countries: ${r.groupsCreated} groups created, ${r.provincesNested} provinces nested, ` +
      `${r.provincesUngrouped} taken out of a group, ${r.disconnected} moved under their continent` +
      (apply ? "" : " (preview, pass --apply)"),
  ];
  if (r.missing.length > 0)
    lines.push(`[vernacular] ${r.missing.length} listed provinces match no region: ${r.missing.join("; ")}`);
  for (const w of r.warnings) lines.push(`[vernacular] ${w}`);
  return lines;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const result = await syncVernacularRegions(pool, apply);
  for (const line of describeVernacularSync(result, apply)) console.log(line);
  await pool.end();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
