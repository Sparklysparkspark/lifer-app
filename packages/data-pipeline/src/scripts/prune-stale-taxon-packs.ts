// One-time cleanup: removes published pack-index.json entries (and their GitHub release
// assets) whose `taxon` is no longer a real TaxonClass — e.g. "collector_shells," which used to
// be its own taxon before being merged back into "marine_mollusks" (see species.ts's own comment
// on that merge). build-pack-index.ts's own carry-forward logic (added to stop a rebuild from
// dropping regions it didn't touch — see that file's own comment) means a legacy taxon like this
// never goes away on its own: nothing ever rebuilds it (its species now come out tagged
// "marine_mollusks"), so it just gets silently carried forward into every future index forever,
// and shows up as a raw, un-labeled "Collector_shells" wherever a taxon picker lists whatever the
// catalog happens to publish (Offline Packs, onboarding's own region-download step).
//
// Safe to delete outright rather than rebuild: every region that has a stale entry here already
// has a real "marine_mollusks" pack in the same index carrying those same species today (that's
// been true since the taxon was merged) — confirmed for the current published index before this
// script was written. This is deliberately a LOCAL script, not CI, same reasoning as
// publish-packs.ts (requires `gh`, already authenticated).
//
// Usage: npm run prune-stale-taxon-packs -w data-pipeline -- [--dry-run]
import { execSync } from "node:child_process";
import { ALL_TAXON_CLASSES } from "@lifer/shared";
import { INDEX_RELEASE_TAG } from "../build/release-groups.js";

const PACK_INDEX_URL = `https://github.com/Sparklysparkspark/lifer-app/releases/download/${INDEX_RELEASE_TAG}/pack-index.json`;
const VALID_TAXA = new Set<string>(ALL_TAXON_CLASSES);

interface PackIndexEntry {
  id: string;
  type: "region" | "seaZone";
  region?: string;
  seaZone?: string;
  taxon?: string | null;
  url: string;
}

function run(cmd: string): string {
  return execSync(cmd, { encoding: "utf8" });
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const res = await fetch(PACK_INDEX_URL);
  if (!res.ok) throw new Error(`Couldn't fetch the published index: HTTP ${res.status}`);
  const index = (await res.json()) as { generatedAt: string; packs: PackIndexEntry[] };

  const stale = index.packs.filter((p) => p.taxon != null && !VALID_TAXA.has(p.taxon));
  if (stale.length === 0) {
    console.log("[prune-stale-taxon-packs] no stale taxon entries found — nothing to do.");
    return;
  }

  const byTaxon = new Map<string, number>();
  for (const p of stale) byTaxon.set(p.taxon!, (byTaxon.get(p.taxon!) ?? 0) + 1);
  console.log(`[prune-stale-taxon-packs] found ${stale.length} stale entr${stale.length === 1 ? "y" : "ies"}:`);
  for (const [taxon, count] of byTaxon) console.log(`  ${taxon}: ${count}`);

  if (dryRun) {
    console.log("[prune-stale-taxon-packs] --dry-run — not deleting anything.");
    return;
  }

  const staleIds = new Set(stale.map((p) => p.id));
  for (const p of stale) {
    const match = p.url.match(/\/releases\/download\/([^/]+)\/([^/]+)$/);
    if (!match) {
      console.warn(`[prune-stale-taxon-packs] couldn't parse release tag/asset from ${p.url} — skipping asset delete for ${p.id}`);
      continue;
    }
    const [, tag, asset] = match;
    try {
      run(`gh release delete-asset ${tag} ${JSON.stringify(asset)} -y`);
      console.log(`[prune-stale-taxon-packs] deleted ${asset} from ${tag}`);
    } catch (err) {
      console.warn(`[prune-stale-taxon-packs] couldn't delete ${asset} from ${tag} (${(err as Error).message}) — continuing`);
    }
  }

  const cleanedIndex = { ...index, packs: index.packs.filter((p) => !staleIds.has(p.id)) };
  // `gh release upload` names the remote asset after the LOCAL file's basename, not the release's
  // existing asset name - a tmp path like /tmp/pack-index.pruned.json silently uploads (and
  // --clobber updates) an asset called "pack-index.pruned.json", never touching the real
  // "pack-index.json" the app actually fetches. Confirmed live: this previously left the published
  // index completely missing for a while after a "successful," no-error run. Using a real
  // "pack-index.json" basename (in its own tmp dir, so it can't collide with anything else) is
  // what makes --clobber replace the right asset.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lifer-pack-index-"));
  const tmpPath = path.join(tmpDir, "pack-index.json");
  fs.writeFileSync(tmpPath, JSON.stringify(cleanedIndex, null, 2));
  run(`gh release upload ${INDEX_RELEASE_TAG} ${JSON.stringify(tmpPath)} --clobber`);
  console.log(`[prune-stale-taxon-packs] uploaded cleaned pack-index.json (${cleanedIndex.packs.length} packs, was ${index.packs.length})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
