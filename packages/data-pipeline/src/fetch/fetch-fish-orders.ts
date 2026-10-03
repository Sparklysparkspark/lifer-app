// Phase 8: GBIF's backbone has no single fish class key: ray-finned fish orders sit directly
// under Chordata (phylum key 44) alongside the tetrapod classes (species/44/children lists 16
// class-rank and 47 order-rank entries).
//
// Full scope covers everything colloquially called "fish," not just ray-finned fish:
//   - 46 ray-finned fish orders (order-rank children of Chordata; the 47th, Copelata, is a
//     tunicate order, excluded)
//   - Myxini (hagfish), Petromyzonti (lampreys), Elasmobranchii (sharks/rays), Holocephali
//     (chimaeras), Coelacanthi (coelacanths), Dipneusti (lungfish), each a class-rank sibling.
// Excluded: the tetrapod classes and Ascidiacea/Thaliacea/Leptocardii (tunicates, lancelets).
import { fetchWithRetry } from "../fetch-with-retry.js";

const CHORDATA_KEY = 44;
const GBIF_BACKBONE_DATASET_KEY = "d7dddbf4-2cf0-4f39-9b2a-bb099caae36c";
const NON_FISH_ORDERS = new Set(["Copelata"]);

// Each checked via species/{key} (rank=CLASS with the expected scientificName).
const EXTRA_FISH_CLASS_KEYS: Record<string, number> = {
  Myxini: 119,
  Petromyzonti: 11881065,
  Elasmobranchii: 121,
  Holocephali: 120,
  Coelacanthi: 11733052,
  Dipneusti: 11500725,
};

interface GbifChild {
  key: number;
  scientificName: string;
  rank: string;
}

async function fetchRayFinnedOrderKeys(): Promise<number[]> {
  const keys: number[] = [];
  let offset = 0;
  for (;;) {
    const url = `https://api.gbif.org/v1/species/${CHORDATA_KEY}/children?datasetKey=${GBIF_BACKBONE_DATASET_KEY}&limit=200&offset=${offset}`;
    const res = await fetchWithRetry(url, {});
    if (!res.ok) throw new Error(`[fish-orders] fetch failed: ${res.status} ${res.statusText}`);
    const data = (await res.json()) as { results: GbifChild[]; endOfRecords: boolean };

    for (const child of data.results) {
      if (child.rank === "ORDER" && !NON_FISH_ORDERS.has(child.scientificName)) {
        keys.push(child.key);
      }
    }

    offset += 200;
    if (data.endOfRecords || data.results.length === 0) break;
  }
  return keys;
}

/** All GBIF higher-taxon keys covering "fish" in the common sense: ray-finned fish orders
 *  plus the jawless-fish/cartilaginous-fish/coelacanth/lungfish classes. */
export async function fetchFishTaxonKeys(): Promise<number[]> {
  const rayFinnedOrders = await fetchRayFinnedOrderKeys();
  const extraClasses = Object.values(EXTRA_FISH_CLASS_KEYS);
  const keys = [...rayFinnedOrders, ...extraClasses];
  console.log(
    `[fish-orders] ${rayFinnedOrders.length} ray-finned order(s) + ${extraClasses.length} extra fish class(es) = ${keys.length} taxon key(s)`,
  );
  return keys;
}
