// Replaces check-extinction-status.ts's per-species GBIF /distributions calls (one live
// request per candidate — 25,013 of them in the last real run) with ONE bulk pull of GBIF's
// own hosted IUCN Red List checklist dataset (confirmed live: dataset
// 19491596-35ae-4a91-9a98-85cf505f1bd3, 338,085 records total, each carrying threatStatuses
// AND its own backbone nubKey — exactly what species.gbif_key stores). Paging through the
// whole checklist once and matching by nubKey is a direct, reliable join (no name-matching
// fuzziness at all) instead of thousands of individual round trips, and this dataset barely
// changes day to day, so re-running this occasionally (as IUCN publishes updates) is enough —
// no per-species "already checked" gating needed the way the old per-species version required.
import { pool } from "../db.js";

const IUCN_DATASET_KEY = "19491596-35ae-4a91-9a98-85cf505f1bd3";
// This checklist's own internal key for Animalia (NOT the backbone's kingdomKey=1 — checklist
// datasets have their own separate taxon-key space, confirmed live by reading a sample
// record's own kingdomKey back). Combined with rank=SPECIES, cuts the walk from 338,085 total
// records (which includes plants/fungi and subspecies/variety-level assessments, none of which
// this catalog has) down to 96,115 — both a correctness improvement (our catalog is
// species-level animals only) and, critically, the fix for a real platform limit: GBIF's
// species/search hard-404s any offset beyond 100,000 (confirmed live: a persistent 400 Bad
// Request at offset=100000, not a transient error retrying ever fixed), so the unfiltered
// 338,085-record walk could never have finished at all.
const ANIMALIA_KEY_IN_THIS_CHECKLIST = 336598482;
const PAGE_SIZE = 1000;

interface IucnRecord {
  nubKey?: number;
  canonicalName?: string;
  threatStatuses?: string[];
}

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
      // A connection reset mid-body-read (confirmed live: "ECONNRESET" on a real run) throws
      // from res.json() itself, not from the fetch() call above — this whole block (not just
      // the request) needs to be inside the retry try/catch, or a single dropped connection
      // crashes the entire multi-minute pull instead of just retrying that one page.
      return (await res.json()) as { results: IucnRecord[]; endOfRecords: boolean };
    } catch (err) {
      console.error(`  network error at offset=${offset} (attempt ${attempt}):`, err instanceof Error ? err.message : err);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw new Error(`giving up on offset=${offset} after retries`);
}

async function main() {
  const extinctGbifKeys = new Set<number>();
  const extinctInWildGbifKeys = new Set<number>();

  let offset = 0;
  let total = 0;
  for (;;) {
    const page = await fetchPage(offset);
    for (const r of page.results) {
      if (!r.nubKey || !r.threatStatuses) continue;
      if (r.threatStatuses.includes("EXTINCT")) extinctGbifKeys.add(r.nubKey);
      else if (r.threatStatuses.includes("EXTINCT_IN_THE_WILD")) extinctInWildGbifKeys.add(r.nubKey);
    }
    total += page.results.length;
    offset += PAGE_SIZE;
    console.log(`[backfill-iucn] fetched ${total} checklist records (${extinctGbifKeys.size} extinct, ${extinctInWildGbifKeys.size} extinct-in-wild so far)`);
    if (page.endOfRecords || page.results.length === 0) break;
  }

  console.log(
    `[backfill-iucn] checklist fully fetched: ${extinctGbifKeys.size} EXTINCT, ${extinctInWildGbifKeys.size} EXTINCT_IN_THE_WILD gbif keys found`,
  );

  const extinctRes = await pool.query(
    `UPDATE species_traits SET fully_extinct = true, iucn_status = 'extinct', extinction_checked_at = now()
     WHERE species_id IN (SELECT id FROM species WHERE gbif_key = ANY($1)) AND COALESCE(fully_extinct, false) = false`,
    [[...extinctGbifKeys]],
  );
  const extinctInWildRes = await pool.query(
    `UPDATE species_traits SET extinct_in_wild = true, iucn_status = 'extinct_in_wild', extinction_checked_at = now()
     WHERE species_id IN (SELECT id FROM species WHERE gbif_key = ANY($1)) AND COALESCE(extinct_in_wild, false) = false`,
    [[...extinctInWildGbifKeys]],
  );

  // Everything else in our catalog that matched neither list is still worth marking checked,
  // so a future incremental run only needs to check newly-added species / a fresh checklist
  // pull, not the whole catalog again.
  const checkedRes = await pool.query(
    `UPDATE species_traits SET extinction_checked_at = now() WHERE extinction_checked_at IS NULL`,
  );

  console.log(
    `[backfill-iucn] done. ${extinctRes.rowCount} species newly marked fully_extinct, ` +
      `${extinctInWildRes.rowCount} newly marked extinct_in_wild, ${checkedRes.rowCount} total rows marked checked.`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
