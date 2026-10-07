// IUCN Red List status for every catalog species, into species_traits.iucn_status (migration 129),
// from the Red List archive GBIF hosts (pipeline/iucnRedList.ts). Matching and the split rules are
// in pipeline/iucnMatch.ts. Without --apply it only reports. Safe to re-run: each run reflects the
// current Red List version, and the refresh's catalog stage runs it every time.
//
//   npx tsx src/scripts/backfill-iucn-status.ts                       report only
//   npx tsx src/scripts/backfill-iucn-status.ts --apply               write
//   --refresh-archive         download the archive even if the cached copy is recent
//   --gbif-fallback=SCOPE     who GBIF is asked about when the names don't match, one call each,
//                             cached in gbif_response_cache: listed (default: species on a
//                             checklist in a group IUCN assesses comprehensively: birds, mammals,
//                             amphibians, reptiles, sharks and rays, corals), comprehensive (every
//                             species in those groups), all, or none
//   --report=FILE             write the per-species decisions as TSV
import { writeFileSync } from "node:fs";
import { pool } from "@lifer/core/db.js";
import { downloadIucnArchive, readIucnArchive } from "../pipeline/iucnRedList.js";
import { backfillIucnStatus, type GbifFallbackScope } from "../pipeline/iucnBackfill.js";

const log = (m: string) => console.log(`[backfill-iucn-status] ${m}`);

async function main() {
  const argv = process.argv.slice(2);
  const value = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const apply = argv.includes("--apply");
  const gbifFallback = (value("gbif-fallback") ?? "listed") as GbifFallbackScope;
  if (!["listed", "comprehensive", "all", "none"].includes(gbifFallback)) {
    throw new Error(`--gbif-fallback must be listed, comprehensive, all or none`);
  }

  const archive = await downloadIucnArchive({ refresh: argv.includes("--refresh-archive"), log });
  const redList = readIucnArchive(archive);
  log(redList.citation ?? "archive has no citation line");

  const result = await backfillIucnStatus(pool, redList, { apply, gbifFallback, gbifDelayMs: 250, log });

  log(
    `matches: ${Object.entries(result.byMethod)
      .map(([k, n]) => `${k} ${n}`)
      .join(", ")}`,
  );
  if (result.gbifLookups) log(`GBIF lookups: ${result.gbifLookups}`);
  console.log("\nListed species by group: missing before -> newly assessed, Not Evaluated, still missing (of listed)");
  for (const [group, g] of Object.entries(result.byGroup).sort(
    (a, b) => b[1].listedMissingBefore - a[1].listedMissingBefore,
  )) {
    console.log(
      `  ${group.padEnd(24)} ${String(g.listedMissingBefore).padStart(6)} -> ${String(g.listedNewlyAssessed).padStart(6)} assessed, ` +
        `${String(g.listedNotEvaluated).padStart(6)} NE, ${String(g.listedStillMissing).padStart(6)} missing (of ${g.listed})`,
    );
  }
  log(`${result.categoryChanges.length} listed species change category (the Red List moved on since Wikidata's copy)`);
  for (const c of result.categoryChanges.slice(0, 15)) console.log(`  ${c.name}: ${c.from} -> ${c.to}`);

  if (result.possibleDuplicates.length > 0) {
    log(
      `${result.possibleDuplicates.length} species look like another catalog species under another genus or spelling (worth a species-merges review):`,
    );
    for (const d of result.possibleDuplicates.slice(0, 10)) console.log(`  ${d.name} = ${d.sameAs}`);
  }

  const reportPath = value("report");
  if (reportPath) {
    const lines = ["species_id\tmatch\tstatus\tsource\tiucn_taxon_id\tnote"];
    for (const [id, d] of result.decisions) {
      const m = result.matches.get(id)!;
      const how =
        m.kind === "assessed"
          ? m.method
          : m.kind === "part_of"
            ? `part_of:${m.via}`
            : m.ambiguous
              ? "ambiguous"
              : "none";
      lines.push([id, how, d.status ?? "", d.source ?? "", d.taxonId ?? "", d.note ?? ""].join("\t"));
    }
    writeFileSync(reportPath, lines.join("\n") + "\n");
    log(`decisions written to ${reportPath}`);
  }
  log(
    apply
      ? `done: ${result.changed} species updated, every catalog species stamped`
      : `dry run: ${result.changed} species would change (--apply to write)`,
  );
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
