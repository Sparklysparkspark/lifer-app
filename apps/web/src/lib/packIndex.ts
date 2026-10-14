import type { TaxonClass } from "@lifer/shared";
import type { ApiResponse } from "../api/client";
import { onPackDownloadFinish } from "./packDownloadStore";
import { addToSetIn } from "./groupInto";
import { createCachedRoute, onAccountReset } from "./resource";
import { ignore } from "./ignore";

type ApiPackEntry = ApiResponse<"/offline-packs/index">["packs"][number];

/** A pack as GET /offline-packs/index lists it: the index entry plus what's installed here. Packs
 *  are published per catalog taxon class (or all of them), which the index sends as plain text. */
export type PackStatusEntry = ApiPackEntry & { taxon?: TaxonClass | null };

// A cold server is still fetching the photo store's index, so sizes come without photos at
// first; one refetch shortly after picks them up.
const SIZES_RETRY_MS = 4000;
let sizesRetry: ReturnType<typeof setTimeout> | null = null;
let sizesRetried = false;

function retryForSizes(pending: boolean): void {
  if (!pending) {
    sizesRetried = false;
    return;
  }
  if (sizesRetried || sizesRetry) return;
  sizesRetried = true;
  sizesRetry = setTimeout(() => {
    sizesRetry = null;
    refreshPackIndex().catch(ignore("Couldn't refresh the pack index"));
  }, SIZES_RETRY_MS);
}

// One cached GET /offline-packs/index for every screen that lists or offers packs, so they all
// agree on what's downloaded.
const packIndex = createCachedRoute("/offline-packs/index", (res) => {
  retryForSizes(res.sizesPending === true);
  return res.packs as PackStatusEntry[];
});

onAccountReset(() => {
  if (sizesRetry) clearTimeout(sizesRetry);
  sizesRetry = null;
  sizesRetried = false;
});

export const loadPackIndex = packIndex.load;
export const refreshPackIndex = packIndex.refresh;

// A finished download changes what's installed, whichever screen started it.
onPackDownloadFinish(() => {
  if (packIndex.getState().data !== null) refreshPackIndex().catch(ignore("Couldn't refresh the pack index"));
});

export function usePackIndex(enabled = true): {
  packs: PackStatusEntry[] | null;
  error: unknown;
  loading: boolean;
  refresh: () => Promise<PackStatusEntry[]>;
} {
  const { data, error, loading, refresh } = packIndex.use(enabled);
  return { packs: data, error, loading, refresh };
}

/** Per downloaded country (packs are keyed by region name), the taxa it has packs for; null in a
 *  set means an all-taxa pack. Sea-zone packs aren't part of the browse tree. */
export function downloadedTaxaByCountry(packs: PackStatusEntry[]): Map<string, Set<string | null>> {
  const byCountry = new Map<string, Set<string | null>>();
  for (const p of packs) {
    if (p.type !== "region" || !p.region || !p.downloaded) continue;
    addToSetIn(byCountry, p.region, p.taxon ?? null);
  }
  return byCountry;
}
