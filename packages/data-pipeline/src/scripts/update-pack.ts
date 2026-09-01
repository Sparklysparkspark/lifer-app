// The single-command version of the pack-update sequence documented in SCRIPTS.md — chains
// compute → enrich → build → publish for a list of countries, instead of a maintainer running
// 2-4 separate scripts by hand and having to already know the right order/flags (the exact
// GBIF_USER/GBIF_PWD trip-up this controller sidesteps by inheriting the same dotenv loading
// apps/api/src/config.ts already does, regardless of which directory this is launched from).
//
// Each stage shells out to the SAME scripts a maintainer would otherwise run individually
// (compute-provinces-bulk.ts, enrich-all-species.ts, build-and-publish-all-packs.ts) — this
// file adds no new region/enrichment/pack-building logic of its own, it only sequences what
// already exists and are already independently tested/battle-worn.
//
// Usage:
//   npx tsx src/scripts/update-pack.ts --countries=Belgium,Netherlands --apply
//   npx tsx src/scripts/update-pack.ts --countries=Japan --taxa=aves,mammalia --apply
//   npx tsx src/scripts/update-pack.ts --countries=Belgium --skip-enrich --skip-build --apply
//
// Flags:
//   --countries=      required. Comma-separated country names, exactly as they appear in the
//                      regions table (same convention compute-provinces-bulk.ts itself uses).
//   --apply            forwarded to the compute step — without it, compute-provinces-bulk.ts
//                      runs as a dry run (submits the GBIF download, computes results, prints
//                      them, writes nothing). Also gates purge-wrong-continent-outliers.ts's own
//                      LIFER_CONFIRM_DELETE requirement in the cleanup stage.
//   --taxa=            forwarded to the "brand new species" enrich sub-stage. If omitted,
//                      auto-detected: whichever taxon_classes have at least one species that's
//                      NEVER been enriched (enriched_at IS NULL) among the given countries'
//                      region_species — a refresh of an already-published region normally finds
//                      nothing here (every one of its species has already been through this at
//                      least once), so this sub-stage is cheap/no-op except for a genuinely new
//                      region. Deliberately NOT the same signal as the photo-recheck sub-stage
//                      below — this is about species the enrichment pipeline has literally
//                      never touched, not ones it touched and came up empty.
//   --skip-photo-recheck   skip re-trying species that WERE already enriched but came up with no
//                          reference_photo (recheck-null-photo-species.ts, scoped to these
//                          countries) — cheap and worth doing on every refresh by default, since
//                          a photo can genuinely become available later even though nothing else
//                          about that species needs re-enriching.
//   --skip-cleanup     skip the post-compute data-quality passes (see runCleanup below).
//   --skip-compute      skip the checklist-computation stage entirely (e.g. re-running just the
//   --skip-enrich       enrich or build steps after a partial run failed midway).
//   --skip-build
//   --budget-gb=, --packs-dir=   forwarded as-is to build-and-publish-all-packs.ts.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pool } from "../db.js";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..", "..", "..", "..");
const API_DIR = path.join(REPO_ROOT, "apps/api");
const DATA_PIPELINE_DIR = path.join(REPO_ROOT, "packages/data-pipeline");

function run(label: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  console.log(`[update-pack] ${label}: npx ${args.join(" ")}`);
  execFileSync("npx", args, { cwd, stdio: "inherit", env });
}

async function autoDetectNewSpeciesTaxa(countries: string[]): Promise<string[]> {
  // Matches a region either named directly among the given countries (a country with no
  // province split) or whose PARENT is (a province row) — region_species rows only ever live
  // on the leaf region, never duplicated onto the country row above it.
  const res = await pool.query<{ taxon_class: string }>(
    `SELECT DISTINCT s.taxon_class
     FROM region_species rs
     JOIN regions r ON r.id = rs.region_id
     LEFT JOIN regions parent ON parent.id = r.parent_id
     JOIN species s ON s.id = rs.species_id
     WHERE (r.name = ANY($1) OR parent.name = ANY($1)) AND s.enriched_at IS NULL`,
    [countries],
  );
  return res.rows.map((r) => r.taxon_class);
}

// Data-quality passes over already-computed region_species/species_traits rows — no live GBIF
// downloads, just catching the kind of thing that made a weird vagrant slip onto a checklist
// (a near-single-record outlier, a hardcoded-false vagrancy flag, an extinct-in-the-wild
// reintroduction misread as a real wild population). Ordered so check-extinction-status.ts's
// own extinct_in_wild flag is set before purge-implausible-extinct-regions.ts reads it.
// detect-implausible-regions.ts never auto-deletes anything (see its own header comment — a
// free-text place-name match isn't reliable enough to trust blind removal) — it's included here
// purely as a printed report for a human to act on, always safe to run regardless of --apply.
function runCleanup(countries: string[], apply: boolean): void {
  run("cleanup: extinction status", ["tsx", "src/scripts/check-extinction-status.ts", `--regions=${countries.join(",")}`], API_DIR);
  run("cleanup: purge implausible extinct", ["tsx", "src/scripts/purge-implausible-extinct-regions.ts"], API_DIR);
  run("cleanup: purge wrong-continent outliers", ["tsx", "src/scripts/purge-wrong-continent-outliers.ts"], API_DIR, {
    ...process.env,
    ...(apply ? { LIFER_CONFIRM_DELETE: "1" } : {}),
  });
  run("cleanup: fix fish region vagrancy", ["tsx", "src/scripts/fix-fish-region-vagrancy.ts"], API_DIR);
  run("cleanup: implausible-region report (manual review)", ["tsx", "src/scripts/detect-implausible-regions.ts", `--regions=${countries.join(",")}`], API_DIR);
}

async function main() {
  const args = process.argv.slice(2);
  const countriesArg = args.find((a) => a.startsWith("--countries="))?.split("=")[1];
  if (!countriesArg) {
    console.error(
      "Usage: npx tsx src/scripts/update-pack.ts --countries=Belgium,Netherlands [--apply] [--taxa=...] [--skip-compute] [--skip-enrich] [--skip-photo-recheck] [--skip-cleanup] [--skip-build] [--budget-gb=] [--packs-dir=]",
    );
    process.exit(1);
  }
  const countries = countriesArg.split(",").map((c) => c.trim()).filter(Boolean);
  const apply = args.includes("--apply");
  const skipCompute = args.includes("--skip-compute");
  const skipEnrich = args.includes("--skip-enrich");
  const skipPhotoRecheck = args.includes("--skip-photo-recheck");
  const skipCleanup = args.includes("--skip-cleanup");
  const skipBuild = args.includes("--skip-build");
  const explicitTaxa = args.find((a) => a.startsWith("--taxa="))?.split("=")[1];
  const budgetArg = args.find((a) => a.startsWith("--budget-gb="));
  const packsDirArg = args.find((a) => a.startsWith("--packs-dir="));

  console.log(
    `[update-pack] ${countries.join(", ")} — compute=${!skipCompute} enrich=${!skipEnrich} photo-recheck=${!skipPhotoRecheck} cleanup=${!skipCleanup} build=${!skipBuild} apply=${apply}`,
  );

  if (!skipCompute) {
    const computeArgs = ["tsx", "src/scripts/compute-provinces-bulk.ts", `--countries=${countries.join(",")}`];
    if (apply) computeArgs.push("--apply");
    run("compute", computeArgs, API_DIR);
  } else {
    console.log("[update-pack] skipping compute stage");
  }

  if (!skipEnrich) {
    const taxa = explicitTaxa ? explicitTaxa.split(",").filter(Boolean) : await autoDetectNewSpeciesTaxa(countries);
    if (taxa.length === 0) {
      console.log("[update-pack] no brand-new species found for these countries, skipping full-enrich sub-stage");
    } else {
      console.log(`[update-pack] enriching brand-new species, taxa: ${taxa.join(", ")}`);
      run("enrich: new species", ["tsx", "src/scripts/enrich-all-species.ts", `--taxa=${taxa.join(",")}`], API_DIR);
    }
  } else {
    console.log("[update-pack] skipping enrich stage entirely");
  }

  if (!skipPhotoRecheck) {
    run("enrich: photo recheck", ["tsx", "src/scripts/recheck-null-photo-species.ts", `--countries=${countries.join(",")}`], API_DIR);
  } else {
    console.log("[update-pack] skipping photo-recheck sub-stage");
  }

  if (!skipCleanup) {
    runCleanup(countries, apply);
  } else {
    console.log("[update-pack] skipping cleanup stage");
  }

  if (!skipBuild) {
    const buildArgs = ["tsx", "src/scripts/build-and-publish-all-packs.ts"];
    if (budgetArg) buildArgs.push(budgetArg);
    if (packsDirArg) buildArgs.push(packsDirArg);
    run("build+publish", buildArgs, DATA_PIPELINE_DIR);
  } else {
    console.log("[update-pack] skipping build stage");
  }

  console.log(`[update-pack] done${apply ? "" : " (dry run — pass --apply to actually write region_species)"}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
