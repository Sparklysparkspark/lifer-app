// Fully-automated "build every remaining country's offline pack" pipeline — the point being
// that once occurrence_computed_at is set for a country (see compute-all-regions-bulk.ts,
// already run world-scale), the pack-building step itself needs zero manual per-country
// triggering: this walks the whole priority-ordered list unattended, flushing (publish, then
// delete the local .tar.gz) whenever the local packs/ directory crosses a disk budget, so a
// multi-hundred-country run never needs more than that budget of free disk at once. Meant to
// be the thing you re-run wholesale every quarter/year when GBIF publishes fresh data — not a
// one-off script tailored to today's specific list.
//
// Usage: npx tsx src/scripts/build-and-publish-all-packs.ts [--budget-gb=30] [--packs-dir=packs]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { pool } from "../db.js";

// User's own explicit ordering (2026-09-01 conversation): personally-relevant countries first,
// then a couple of large/biodiverse representatives for the continents nothing else covers yet
// (Europe/North America are already well covered by the priority list + Canada/US), then every
// other computed country alphabetically. Countries already published (US, Canada, Finland) are
// filtered out at runtime by checking the existing pack index, not hardcoded here, so re-running
// this script later just picks up wherever it left off.
const PRIORITY_COUNTRIES = [
  "France",
  "Germany",
  "United Kingdom",
  "Belgium",
  "Netherlands",
  "Switzerland",
  "Austria",
  "Italy",
  "Spain",
  "Luxembourg",
  "Denmark",
  "Ireland",
  "Poland",
  "Czechia",
];
const CONTINENT_REPRESENTATIVE_COUNTRIES = ["Brazil", "Colombia", "Kenya", "South Africa", "India", "Japan", "Australia", "New Zealand"];

// Mirrors build-region-pack.ts's own local TAXON_CLASSES tuple exactly (same duplication
// pattern that file already uses instead of importing packages/shared's TaxonClass — see its
// own comment). Every country now gets split into per-taxon packs, same shape as Canada/Finland
// already had, so the Offline Packs picker's per-taxon size estimate means something everywhere
// instead of just those two countries. build-region-pack.ts skips writing an archive for any
// taxon with 0 species in that region, so this doesn't publish empty packs for e.g. corals in a
// landlocked country.
const TAXON_CLASSES = [
  "aves",
  "mammalia",
  "actinopterygii",
  "elasmobranchii",
  "aquatic_mammalia",
  "amphibia",
  "squamata",
  "testudines",
  "crocodylia",
  "corals",
  "jellies_and_anemones",
  "echinodermata",
  "nudibranchs",
  "collector_shells",
  "marine_mollusks",
  "cephalopoda",
  "crustacea",
  "sponges_tunicates_other",
];

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..", "..", "..", "..");

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function packsDirSizeBytes(packsDir: string): number {
  if (!existsSync(packsDir)) return 0;
  let total = 0;
  for (const file of readdirSync(packsDir)) {
    if (!file.endsWith(".pack.tar.gz")) continue;
    total += statSync(path.join(packsDir, file)).size;
  }
  return total;
}

// Already-published country names, read from the CURRENT pack index (rebuilt at the end of
// every flush) rather than a hardcoded skip-list — so re-running this script after an earlier
// partial run, or after manually publishing a country by hand, correctly picks up where things
// left off instead of redoing work. Requires an actual per-TAXON entry (not just any pack for
// that country) — every country used to get one combined "all taxa" pack (taxon: null), which
// no longer counts as done now that this script always builds the per-taxon split; only
// Canada/Finland (built earlier, already split) and anything this script itself has since
// published correctly skip a rebuild.
async function alreadyPublishedCountryNames(packsDir: string): Promise<Set<string>> {
  const indexPath = path.join(packsDir, "pack-index.json");
  if (!existsSync(indexPath)) return new Set();
  const { readFileSync } = await import("node:fs");
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as { packs: Array<{ type: string; region?: string; taxon?: string | null }> };
  return new Set(index.packs.filter((p) => p.type === "region" && p.region && p.taxon != null).map((p) => p.region!));
}

async function main() {
  const args = process.argv.slice(2);
  const budgetGb = Number(args.find((a) => a.startsWith("--budget-gb="))?.split("=")[1] ?? "30");
  const packsDir = path.resolve(args.find((a) => a.startsWith("--packs-dir="))?.split("=")[1] ?? path.join(REPO_ROOT, "packages/data-pipeline/packs"));
  const budgetBytes = budgetGb * 1024 * 1024 * 1024;
  mkdirSync(packsDir, { recursive: true });

  const computedRes = await pool.query<{ name: string }>(
    `SELECT r.name FROM regions r
     JOIN regions c ON c.id = r.parent_id AND c.parent_id = (SELECT id FROM regions WHERE name = 'World')
     WHERE r.occurrence_computed_at IS NOT NULL ORDER BY r.name`,
  );
  const computedNames = computedRes.rows.map((r) => r.name);
  const computedSet = new Set(computedNames);

  const publishedAtStart = await alreadyPublishedCountryNames(packsDir);

  const priorityInOrder = [...PRIORITY_COUNTRIES, ...CONTINENT_REPRESENTATIVE_COUNTRIES].filter((n) => computedSet.has(n));
  const prioritySet = new Set(priorityInOrder);
  const everyoneElse = computedNames.filter((n) => !priorityInOrder.includes(n)).sort();
  const fullOrder = [...priorityInOrder, ...everyoneElse].filter((n) => !publishedAtStart.has(n));

  console.log(
    `[build-and-publish-all-packs] ${computedNames.length} computed countries total, ${publishedAtStart.size} already published, ${fullOrder.length} to build now (budget ${budgetGb}GB)`,
  );
  if (fullOrder.some((n) => priorityInOrder.includes(n))) {
    console.log(`[build-and-publish-all-packs] priority order: ${fullOrder.filter((n) => priorityInOrder.includes(n)).join(", ")}`);
  }

  let built = 0;
  let failed = 0;
  for (const [i, name] of fullOrder.entries()) {
    try {
      // One archive per taxon class (build-region-pack.ts itself skips writing anything for a
      // taxon with 0 species in this region, e.g. corals in a landlocked country) — no combined
      // "all taxa" pack anymore, matching Canada/Finland's existing split.
      for (const taxon of TAXON_CLASSES) {
        run("npx", ["tsx", "src/build/build-region-pack.ts", name, packsDir, `--taxon=${taxon}`], path.join(REPO_ROOT, "packages/data-pipeline"));
      }
      built++;
    } catch (err) {
      console.error(`[build-and-publish-all-packs] FAILED building ${name}: ${(err as Error).message}`);
      failed++;
      continue;
    }
    const sizeBytes = packsDirSizeBytes(packsDir);
    console.log(
      `[build-and-publish-all-packs] ${i + 1}/${fullOrder.length} built ${name} (packs dir now ${(sizeBytes / 1024 / 1024 / 1024).toFixed(2)}GB)`,
    );
    if (sizeBytes >= budgetBytes) {
      console.log(`[build-and-publish-all-packs] hit ${budgetGb}GB budget — publishing and clearing local archives`);
      run("npx", ["tsx", "src/build/build-pack-index.ts", packsDir], path.join(REPO_ROOT, "packages/data-pipeline"));
      run("npx", ["tsx", "src/scripts/publish-packs.ts", packsDir], path.join(REPO_ROOT, "packages/data-pipeline"));
      for (const file of readdirSync(packsDir)) {
        if (file.endsWith(".pack.tar.gz")) rmSync(path.join(packsDir, file));
      }
      console.log(`[build-and-publish-all-packs] flushed — local packs dir cleared, all published to packs-latest`);
    }
  }

  // Final flush for whatever's left under budget.
  if (packsDirSizeBytes(packsDir) > 0) {
    run("npx", ["tsx", "src/build/build-pack-index.ts", packsDir], path.join(REPO_ROOT, "packages/data-pipeline"));
    run("npx", ["tsx", "src/scripts/publish-packs.ts", packsDir], path.join(REPO_ROOT, "packages/data-pipeline"));
  }

  console.log(`[build-and-publish-all-packs] done. ${built} built, ${failed} failed.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
