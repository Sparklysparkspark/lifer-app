// The main 18-taxon catalog never had species.iucn_status populated at all (migration 091 added
// the column only for Other Taxa species, resolved live from iNaturalist at add time) — every
// one of the ~116k built-in species showed a blank IUCN stat. Reuses the exact same bulk GBIF
// IUCN Red List checklist dataset + nubKey-matching approach as
// scripts/archive/backfill-extinction-from-iucn-checklist.ts (that script only cared about the
// EXTINCT/EXTINCT_IN_THE_WILD statuses; this one persists whichever status each species actually
// has, the same way Other Taxa species already show one). Re-runnable/idempotent — always
// overwrites, safe to re-run as IUCN publishes updates or the catalog grows.
import { pool } from "../db.js";

const IUCN_DATASET_KEY = "19491596-35ae-4a91-9a98-85cf505f1bd3";
const ANIMALIA_KEY_IN_THIS_CHECKLIST = 336598482;
const PAGE_SIZE = 1000;

interface IucnRecord {
  nubKey?: number;
  canonicalName?: string;
  threatStatuses?: string[];
}

// GBIF's checklist gives the full enum code (e.g. "LEAST_CONCERN"), never a display name.
const STATUS_NAMES: Record<string, string> = {
  EXTINCT: "Extinct",
  EXTINCT_IN_THE_WILD: "Extinct in the Wild",
  CRITICALLY_ENDANGERED: "Critically Endangered",
  ENDANGERED: "Endangered",
  VULNERABLE: "Vulnerable",
  NEAR_THREATENED: "Near Threatened",
  LEAST_CONCERN: "Least Concern",
  DATA_DEFICIENT: "Data Deficient",
  NOT_EVALUATED: "Not Evaluated",
};

// A species can carry more than one threatStatuses entry (rare, but the checklist doesn't
// guarantee exactly one) — picks the most severe, so "this species is at real risk" never gets
// silently masked by a less alarming secondary entry.
const SEVERITY_ORDER = [
  "EXTINCT",
  "EXTINCT_IN_THE_WILD",
  "CRITICALLY_ENDANGERED",
  "ENDANGERED",
  "VULNERABLE",
  "NEAR_THREATENED",
  "LEAST_CONCERN",
  "DATA_DEFICIENT",
  "NOT_EVALUATED",
];

async function fetchPage(offset: number): Promise<{ results: IucnRecord[]; endOfRecords: boolean }> {
  const url = `https://api.gbif.org/v1/species/search?datasetKey=${IUCN_DATASET_KEY}&highertaxonKey=${ANIMALIA_KEY_IN_THIS_CHECKLIST}&rank=SPECIES&limit=${PAGE_SIZE}&offset=${offset}`;
  for (let attempt = 0; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
        console.error(`  429 at offset=${offset}, backing off ${Math.round(delayMs / 1000)}s`);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      if (!res.ok) throw new Error(`GBIF checklist fetch failed: ${res.status} ${res.statusText} (offset ${offset})`);
      return (await res.json()) as { results: IucnRecord[]; endOfRecords: boolean };
    } catch (err) {
      console.error(`  network error at offset=${offset} (attempt ${attempt}):`, err instanceof Error ? err.message : err);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw new Error(`giving up on offset=${offset} after retries`);
}

async function main() {
  const statusByGbifKey = new Map<number, string>();

  let offset = 0;
  let total = 0;
  for (;;) {
    const page = await fetchPage(offset);
    for (const r of page.results) {
      if (!r.nubKey || !r.threatStatuses?.length) continue;
      const best = SEVERITY_ORDER.find((s) => r.threatStatuses!.includes(s));
      if (best) statusByGbifKey.set(r.nubKey, STATUS_NAMES[best] ?? best);
    }
    total += page.results.length;
    offset += PAGE_SIZE;
    console.log(`[backfill-iucn-status] fetched ${total} checklist records (${statusByGbifKey.size} with a usable status so far)`);
    if (page.endOfRecords || page.results.length === 0) break;
  }

  console.log(`[backfill-iucn-status] checklist fully fetched: ${statusByGbifKey.size} distinct gbif keys with a status`);

  let updated = 0;
  for (const [gbifKey, status] of statusByGbifKey) {
    const res = await pool.query(
      `UPDATE species SET iucn_status = $1 WHERE gbif_key = $2 AND is_other_taxa = false AND iucn_status IS DISTINCT FROM $1`,
      [status, gbifKey],
    );
    updated += res.rowCount ?? 0;
  }

  console.log(`[backfill-iucn-status] done. ${updated} species updated.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
