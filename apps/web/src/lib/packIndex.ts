import { ALL_TAXON_CLASSES, type TaxonClass } from "@lifer/shared";
import type { ApiResponse } from "../api/client";
import { onPackDownloadFinish } from "./packDownloadStore";
import { addToSetIn } from "./groupInto";
import { createCachedRoute, onAccountReset } from "./resource";
import { ignore } from "./ignore";
import { useOnline } from "../hooks/useOnline";

/** The connection as every download screen describes it: "offline" only when this computer says
 *  so or the host can't be reached at all; "slow" while it answers late (downloads still work). */
export type RemoteState = "online" | "slow" | "offline";

type ApiPackEntry = ApiResponse<"/offline-packs/index">["packs"][number];

/** A pack as GET /offline-packs/index lists it: the index entry plus what's installed here. Packs
 *  are published per catalog taxon class (or all of them), which the index sends as plain text. */
export type PackStatusEntry = ApiPackEntry & { taxon?: TaxonClass | null };

// One cached GET /offline-packs/index for every screen that lists or offers packs, so they all
// agree on what's downloaded.
// Set with each load, so it changes exactly when the packs do and needs no store of its own.
let freeBytes: number | null = null;
let indexUnavailable = false;
let remote: RemoteState = "online";
let indexProgress: { receivedBytes: number; totalBytes: number | null } | null = null;
let sizesPending = false;
const packIndex = createCachedRoute("/offline-packs/index", (res) => {
  sizesPending = res.sizesPending === true;
  freeBytes = res.freeBytes;
  indexUnavailable = res.indexUnavailable === true;
  remote = res.remote ?? "online";
  indexProgress = res.indexProgress ?? null;
  // Pending photo sizes (a first start with nothing saved) are followed the same way.
  followRefresh(res.indexRefreshing === true || remote !== "online" || sizesPending);
  return res.packs as PackStatusEntry[];
});

// The server answers from what it has and refreshes the published list in the background; this
// asks again until the newer list (or a better connection) is in, backing off up to a minute.
const FOLLOW_MIN_MS = 5_000;
const FOLLOW_MAX_MS = 60_000;
let followTimer: ReturnType<typeof setTimeout> | null = null;
let followDelay = FOLLOW_MIN_MS;
function followRefresh(pending: boolean): void {
  if (!pending) {
    followDelay = FOLLOW_MIN_MS;
    return;
  }
  if (followTimer) return;
  followTimer = setTimeout(() => {
    followTimer = null;
    refreshPackIndex().catch(ignore("Couldn't refresh the pack index"));
  }, followDelay);
  followDelay = Math.min(FOLLOW_MAX_MS, followDelay * 2);
}

onAccountReset(() => {
  if (followTimer) clearTimeout(followTimer);
  followTimer = null;
  followDelay = FOLLOW_MIN_MS;
});

export const loadPackIndex = packIndex.load;
export const refreshPackIndex = packIndex.refresh;

// A finished download changes what's installed, whichever screen started it.
onPackDownloadFinish(() => {
  if (packIndex.getState().data !== null) refreshPackIndex().catch(ignore("Couldn't refresh the pack index"));
});

export function usePackIndex(enabled = true): {
  packs: PackStatusEntry[] | null;
  /** Free space where packs are stored; null when unknown. */
  freeBytes: number | null;
  /** No list of what could be downloaded yet: `packs` holds only what's installed. */
  indexUnavailable: boolean;
  /** How the server's last reach for the published list went (see useConnection). */
  remote: RemoteState;
  /** How far the list of downloads has got while it's still coming in; null otherwise. */
  listProgress: { receivedBytes: number; totalBytes: number | null } | null;
  /** Sizes don't include photos yet: show no size rather than a too-small one. */
  sizesPending: boolean;
  error: unknown;
  loading: boolean;
  refresh: () => Promise<PackStatusEntry[]>;
} {
  const { data, error, loading, refresh } = packIndex.use(enabled);
  return {
    packs: data,
    freeBytes: data ? freeBytes : null,
    indexUnavailable: !!data && indexUnavailable,
    remote: data ? remote : "online",
    listProgress: data ? indexProgress : null,
    sizesPending: !!data && sizesPending,
    error,
    loading,
    refresh,
  };
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

export type DownloadVariant = "full" | "small";

export interface CountryGroup {
  taxon: TaxonClass;
  /** Every one of the countries that has this group has it downloaded. */
  downloaded: boolean;
  /** What downloading it for the countries still missing it would fetch, per variant. */
  sizeBytes: Record<DownloadVariant, number>;
}

/** What downloading these packs fetches: each one (photos included, as the server prices it)
 *  plus the sea zones it pulls in that aren't here yet, each counted once. */
export function downloadBytes(chosen: PackStatusEntry[], byId: Map<string, PackStatusEntry>): number {
  const counted = new Set(chosen.map((p) => p.id));
  let total = 0;
  for (const p of chosen) {
    total += p.sizeBytes;
    for (const dep of p.seaZoneDependencies ?? []) {
      // A small install pulls in small sea zones (download.ts).
      const id = p.variant === "small" ? `${dep}.small` : dep;
      const zone = byId.get(id);
      if (counted.has(id) || !zone || zone.downloaded) continue;
      counted.add(id);
      total += zone.sizeBytes;
    }
  }
  return total;
}

/** The animal groups these countries have packs for, in picker order, each with whether it's
 *  already downloaded everywhere and, per variant, the size of the rest. */
export function groupsForCountries(packs: PackStatusEntry[], countryNames: string[]): CountryGroup[] {
  const have = downloadedTaxaByCountry(packs);
  const names = new Set(countryNames);
  const byId = new Map(packs.map((p) => [p.id, p]));
  const byTaxon = new Map<TaxonClass, { downloaded: boolean; missing: Record<DownloadVariant, PackStatusEntry[]> }>();
  for (const p of packs) {
    if (p.type !== "region" || !p.region || !p.taxon || !names.has(p.region)) continue;
    let group = byTaxon.get(p.taxon);
    if (!group) byTaxon.set(p.taxon, (group = { downloaded: true, missing: { full: [], small: [] } }));
    const owned = have.get(p.region);
    if (owned?.has(null) || owned?.has(p.taxon)) continue;
    group.downloaded = false;
    group.missing[p.variant ?? "full"].push(p);
  }
  return ALL_TAXON_CLASSES.flatMap((taxon) => {
    const group = byTaxon.get(taxon);
    if (!group) return [];
    const sizeBytes = {
      full: downloadBytes(group.missing.full, byId),
      small: downloadBytes(group.missing.small, byId),
    };
    return [{ taxon, downloaded: group.downloaded, sizeBytes }];
  });
}

/** The one connection state behind every "offline" or "slow" note, so the wording agrees. */
export function useConnection(): RemoteState {
  const online = useOnline();
  const { remote: lastReach } = usePackIndex();
  return online ? lastReach : "offline";
}
