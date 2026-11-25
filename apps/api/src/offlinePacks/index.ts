// The published pack index: fetching and caching it, and the routes that list packs.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { requireAuth, requireScope } from "../auth/session.js";
import { replies, withSchemas } from "../lib/schema.js";
import { PackList, PackRecommendation, PackUpdatesSummary } from "./responses.js";
import { APP_DATA_DIR, PACK_INDEX_URL } from "@lifer/core/config.js";
import { freeSpace } from "@lifer/core/lib/freeSpace.js";
import { fetchPhotoStoreIndex, lastPhotoStoreIndex } from "./photoStore.js";
import { type PackIndex, type PackIndexEntry } from "./schemas.js";
import { loadIndexFile, namesOf, yieldToEventLoop, type LoadedIndex, type PackNames } from "./indexLoader.js";
import { log } from "@lifer/core/lib/log.js";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { downloadResumable } from "@lifer/core/lib/resumableDownload.js";
import path from "node:path";
import { backoffMemo, remoteStateOf, type RemoteState } from "../lib/remoteFetch.js";

export type { PackIndex, PackIndexEntry } from "./schemas.js";
export { assertTrustedPackUrl } from "./packPaths.js";

/** A ".small" pack id is the same pack installed without gallery photos. */
export const SMALL_SUFFIX = ".small";
export function basePackId(id: string): { id: string; small: boolean } {
  return id.endsWith(SMALL_SUFFIX) ? { id: id.slice(0, -SMALL_SUFFIX.length), small: true } : { id, small: false };
}

// The full index is about 22 MB (species names dominate it), which a weak signal takes minutes
// to bring in. So: a lite copy without species names first (fills the list), then the full one
// (photo sizes, recommendations), each downloaded to a file in app data, resumed with Range
// requests across attempts and restarts, and given up only after 30 s with no bytes at all.
// Listing answers at once from whatever copy is on hand and refreshes in the background.
const PACK_INDEX_TTL_MS = 15 * 60_000;
// Parsed once per load or download, in a worker (indexLoader.ts), and kept: requests never parse
// it again. Listing uses the packs alone; the species names (photo sizes, recommendations) sit
// beside them, packed, once the full file has been read.
let packIndexCache: { at: number; index: PackIndex; names: PackNames | null } | null = null;
let inFlight: { lite: Promise<PackIndex | null>; full: Promise<PackIndex> } | null = null;
// One read of the saved copies, shared by every route that asks at startup.
let savedLoad: Promise<PackIndex | null> | null = null;
let namesLoad: Promise<PackNames | null> | null = null;
// Failures back off (10 s up to 2 minutes); the partial file keeps what each attempt got.
const failures = backoffMemo();
// What the last attempt said: a timeout or stall is only "slow", never "offline".
let remoteState: RemoteState = "online";
// The file being fetched now and how far it is.
let progress: { receivedBytes: number; totalBytes: number | null } | null = null;
const SAVED_INDEX_PATH = path.join(APP_DATA_DIR, "pack-index-cache.json");
// Downloaded lite index, or one derived from the full file: what a start reads first.
const SAVED_LITE_PATH = path.join(APP_DATA_DIR, "pack-index-lite-cache.json");
const STALL_MS = 30_000;
// Published beside the full index by the pipeline (pipeline/packIndex.ts); older publishes lack it.
const LITE_URL = PACK_INDEX_URL?.endsWith("/pack-index.json")
  ? PACK_INDEX_URL.replace(/pack-index\.json$/, "pack-index-lite.json")
  : null;

/** Downloads one index file resumably, reads it whole in a worker, then swaps it in for the saved
 *  copy. A full index also leaves a lite copy beside it for the next start. */
async function downloadIndexFile(url: string, savedPath: string, what: string): Promise<LoadedIndex> {
  const tmp = `${savedPath}.download`;
  await mkdir(path.dirname(savedPath), { recursive: true });
  await downloadResumable(url, tmp, {
    stallTimeoutMs: STALL_MS,
    label: what,
    attempts: 3,
    onProgress: (receivedBytes, totalBytes) => {
      progress = { receivedBytes, totalBytes };
    },
  });
  let loaded: LoadedIndex;
  try {
    loaded = await loadIndexFile(tmp, savedPath === SAVED_INDEX_PATH ? { writeLiteTo: SAVED_LITE_PATH } : {});
  } catch (err) {
    // A complete file that doesn't parse is no use to resume from.
    await rm(tmp, { force: true });
    throw err;
  }
  await rename(tmp, savedPath);
  return loaded;
}

function noteFailure(err: unknown, what: string): Error {
  remoteState = remoteStateOf(err);
  log.warn({ err }, `[packs] couldn't fetch ${what}`);
  return failures.fail(err);
}

/** One refresh at a time, shared by every caller: the lite index, then the full one. */
function refresh(): { lite: Promise<PackIndex | null>; full: Promise<PackIndex> } {
  if (inFlight) return inFlight;
  const lite = (async () => {
    if (!LITE_URL) return null;
    try {
      const { index } = await downloadIndexFile(LITE_URL, SAVED_LITE_PATH, "the region download list");
      if (!packIndexCache?.names || packIndexCache.index.generatedAt < index.generatedAt)
        packIndexCache = { at: Date.now(), index, names: null };
      remoteState = "online";
      return index;
    } catch (err) {
      // Not published (an older publish): the full index alone will do.
      if ((err as { status?: number }).status === 404) return null;
      throw noteFailure(err, "the region download list");
    }
  })();
  const full = (async () => {
    // One file at a time: a weak signal shares nothing well.
    await lite.catch(() => {});
    try {
      const { index, names } = await downloadIndexFile(PACK_INDEX_URL!, SAVED_INDEX_PATH, "the region download index");
      packIndexCache = { at: Date.now(), index, names };
      failures.clear();
      remoteState = "online";
      return index;
    } catch (err) {
      throw noteFailure(err, "the region download index");
    }
  })();
  lite.catch(() => {});
  full
    .catch(() => {})
    .finally(() => {
      inFlight = null;
      progress = null;
    });
  inFlight = { lite, full };
  return inFlight;
}

/** The index for whoever needs it now.
 *  - Default: any copy on hand at once (refreshing it in the background when stale); with none,
 *    waits for the first to arrive. `wait: false` returns null instead of waiting.
 *  - `fresh` (a download): a copy under 15 minutes old, else the newest it can get, falling back
 *    to the last copy.
 *  Species names are left empty; packNames() has them. */
export async function fetchPackIndex(opts: { fresh: true }): Promise<PackIndex>;
export async function fetchPackIndex(opts?: Record<string, never>): Promise<PackIndex>;
export async function fetchPackIndex(opts: { wait: false }): Promise<PackIndex | null>;
export async function fetchPackIndex(opts: { fresh?: boolean; wait?: boolean } = {}): Promise<PackIndex | null> {
  if (!PACK_INDEX_URL) throw new Error("No region download index is configured for this instance yet");
  const cached = packIndexCache?.index ?? (await lastKnownIndex());
  const stale = !packIndexCache || Date.now() - packIndexCache.at >= PACK_INDEX_TTL_MS;
  // Fresh enough already: a download needn't fetch the list again on a weak signal.
  if (opts.fresh && cached && !stale) return cached;
  if (opts.fresh) {
    try {
      const r = refresh();
      return (await r.lite.catch(() => null)) ?? (await r.full);
    } catch (err) {
      if (cached) return cached;
      throw err;
    }
  }
  if (cached) {
    if (stale && !failures.recent()) refresh();
    return cached;
  }
  if (opts.wait === false) {
    if (!failures.recent()) refresh();
    return null;
  }
  const failed = failures.recent();
  if (failed) throw failed;
  const r = refresh();
  return (await r.lite.catch(() => null)) ?? (await r.full);
}

/** The index with its packs' species names (recommendations): the saved full copy, read once in
 *  a worker, else the full download, waited for. */
export async function packNames(): Promise<{ index: PackIndex; names: PackNames }> {
  if (!PACK_INDEX_URL) throw new Error("No region download index is configured for this instance yet");
  await lastKnownIndex();
  const stale = !packIndexCache || Date.now() - packIndexCache.at >= PACK_INDEX_TTL_MS;
  if (!packIndexCache?.names) await loadSavedNames();
  if (packIndexCache?.names && !stale) return { index: packIndexCache.index, names: packIndexCache.names };
  await refresh().full;
  if (!packIndexCache?.names) throw new Error("The region download index has no species names");
  return { index: packIndexCache.index, names: packIndexCache.names };
}

/** Names from the saved full copy, read once in a worker; null when there's none. */
function loadSavedNames(): Promise<PackNames | null> {
  if (packIndexCache?.names) return Promise.resolve(packIndexCache.names);
  namesLoad ??= loadIndexFile(SAVED_INDEX_PATH, { writeLiteTo: SAVED_LITE_PATH })
    .then(({ index, names }) => {
      // The saved full copy may be older than a lite one fetched since: keep the newer packs.
      if (!packIndexCache || packIndexCache.index.generatedAt <= index.generatedAt)
        packIndexCache = { at: packIndexCache?.at ?? 0, index, names };
      return names;
    })
    .catch(() => null)
    .finally(() => {
      namesLoad = null;
    });
  return namesLoad;
}

/** How the connection to the published index looks, and how far a refresh has got. */
export function packIndexRemoteState(): {
  state: RemoteState;
  refreshing: boolean;
  progress: { receivedBytes: number; totalBytes: number | null } | null;
} {
  return { state: remoteState, refreshing: inFlight !== null, progress: inFlight ? progress : null };
}

/** The last index this install fetched (memory, else the saved lite copy, else the saved full one,
 *  read in a worker), or null. Possibly stale. One read shared by every caller. */
function lastKnownIndex(): Promise<PackIndex | null> {
  if (packIndexCache) return Promise.resolve(packIndexCache.index);
  savedLoad ??= (async () => {
    try {
      const { index } = await loadIndexFile(SAVED_LITE_PATH);
      packIndexCache ??= { at: 0, index, names: null };
      return packIndexCache.index;
    } catch {
      // No lite copy (an install from before lite copies): the full one, which leaves one behind.
      const names = await loadSavedNames();
      return names || packIndexCache ? (packIndexCache?.index ?? null) : null;
    }
  })().finally(() => {
    savedLoad = null;
  });
  return savedLoad;
}

/** Test hook: forget the cached, failed and in-flight state (files on disk stay). */
export function resetPackIndexCache(): void {
  packIndexCache = null;
  inFlight = null;
  savedLoad = null;
  namesLoad = null;
  progress = null;
  remoteState = "online";
  failures.clear();
  savedSizes = null;
  sizesMemo = null;
  localState = null;
}

// What each pack adds or holds on this install: its checklist plus photos not yet on disk
// (main photos only for ".small"), or for an installed pack, its photos on disk.
const LOCAL_STATE_TTL_MS = 60_000;
let localState: { at: number; idByName: Map<string, string>; hasMain: Set<string>; hasGallery: Set<string> } | null =
  null;
async function localPhotoState() {
  if (localState && Date.now() - localState.at < LOCAL_STATE_TTL_MS) return localState;
  const [species, gallery] = await Promise.all([
    pool.query<{ id: string; scientific_name: string; has_main: boolean }>(
      `SELECT id, scientific_name, reference_display_path IS NOT NULL AS has_main FROM species WHERE NOT is_other_taxa`,
    ),
    pool.query<{ species_id: string; photo_url: string }>(
      `SELECT species_id, photo_url FROM species_reference_photos WHERE display_path IS NOT NULL`,
    ),
  ]);
  localState = {
    at: Date.now(),
    idByName: new Map(species.rows.map((r) => [r.scientific_name, r.id])),
    hasMain: new Set(species.rows.filter((r) => r.has_main).map((r) => r.id)),
    hasGallery: new Set(gallery.rows.map((r) => `${r.species_id}|${r.photo_url}`)),
  };
  return localState;
}

/** Forgets the cached local state, after an install or removal changed it. */
export function invalidatePackSizes(): void {
  localState = null;
}

// How long a pack list waits for a cold photo store index (a large download) before answering
// with sizes pending; the fetch carries on in the background for the next request.
const COLD_PHOTO_INDEX_WAIT_MS = 3_000;

// The last per-pack photo sizes, saved small (a few numbers per pack) so a start or an offline
// one prices packs at once instead of waiting on the photo store index. Used only while the pack
// index, photo store and photos on disk are the ones they were worked out for.
const SAVED_SIZES_PATH = path.join(APP_DATA_DIR, "pack-photo-sizes-cache.json");
let savedSizes: Promise<{ key: string; value: PhotoSizes } | null> | null = null;
const sizesKey = (index: PackIndex, local: Awaited<ReturnType<typeof localPhotoState>>) =>
  `${index.generatedAt}|${index.photoStore?.indexUrl}|${local.idByName.size}|${local.hasMain.size}|${local.hasGallery.size}`;

async function savedPhotoSizes(index: PackIndex): Promise<PhotoSizes | null> {
  savedSizes ??= readFile(SAVED_SIZES_PATH, "utf8")
    .then((text) => {
      const saved = JSON.parse(text) as { key: string; sizes: Array<[string, number, number, number]> };
      if (typeof saved.key !== "string" || !Array.isArray(saved.sizes)) return null;
      const value: PhotoSizes = new Map(
        saved.sizes.map(([id, missing, missingMain, present]) => [id, { missing, missingMain, present }]),
      );
      return { key: saved.key, value };
    })
    .catch(() => null);
  const saved = await savedSizes;
  return saved && saved.key === sizesKey(index, await localPhotoState()) ? saved.value : null;
}

function savePhotoSizes(key: string, value: PhotoSizes): void {
  savedSizes = Promise.resolve({ key, value });
  const sizes = [...value].map(([id, s]) => [id, s.missing, s.missingMain, s.present]);
  const tmp = `${SAVED_SIZES_PATH}.tmp`;
  mkdir(APP_DATA_DIR, { recursive: true })
    .then(() => writeFile(tmp, JSON.stringify({ key, sizes })))
    .then(() => rename(tmp, SAVED_SIZES_PATH))
    .catch((err) => log.warn({ err }, "[packs] couldn't save pack photo sizes"));
}

// The per-pack sums walk every pack's species (about a million names across thousands of packs),
// so each distinct species is priced once, the packs are summed from those, the loop yields to
// the event loop as it goes, and the answer is kept (and shared while it's being worked out) for
// as long as the names, the photo store index and the local state are the same objects (an
// install or removal replaces the local state).
type PhotoSizes = Map<string, { missing: number; missingMain: number; present: number }>;
let sizesMemo: { names: PackNames; store: object; local: object; value: Promise<PhotoSizes> } | null = null;
const SIZES_CHUNK = 2_000;

/** Photo bytes per pack, or null while unknown (no photo store index here or saved sizes yet).
 *  Answers at once from what's on hand; online, a newer photo store index replaces it later. */
async function photoSizes(index: PackIndex, names: PackNames, online: boolean): Promise<PhotoSizes | null> {
  const indexUrl = index.photoStore!.indexUrl;
  let store = lastPhotoStoreIndex(indexUrl);
  if (online) {
    const fetching = fetchPhotoStoreIndex(indexUrl);
    // Handled below when awaited; this keeps a later failure from going unhandled.
    fetching.catch(() => {});
    if (!store) {
      const saved = await savedPhotoSizes(index);
      if (saved) return saved;
      let timer: NodeJS.Timeout | undefined;
      store = await Promise.race([
        fetching.catch(() => null),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), COLD_PHOTO_INDEX_WAIT_MS);
        }),
      ]).finally(() => clearTimeout(timer));
      if (!store) {
        fetching.catch((err) => log.warn({ err }, "[packs] couldn't fetch the pack photo index"));
        return null;
      }
    }
  }
  if (!store) return savedPhotoSizes(index);
  const local = await localPhotoState();
  if (sizesMemo && sizesMemo.names === names && sizesMemo.store === store && sizesMemo.local === local)
    return sizesMemo.value;
  const key = sizesKey(index, local);
  const value = sumPhotoSizes(names, store, local);
  value.then((v) => savePhotoSizes(key, v)).catch(() => {});
  sizesMemo = { names, store, local, value };
  return value;
}

async function sumPhotoSizes(
  names: PackNames,
  store: Awaited<ReturnType<typeof fetchPhotoStoreIndex>>,
  local: Awaited<ReturnType<typeof localPhotoState>>,
): Promise<PhotoSizes> {
  const refBytes = (pair?: { d?: [number, number, number, string]; t?: [number, number, number, string] }) =>
    (pair?.d?.[2] ?? 0) + (pair?.t?.[2] ?? 0);
  // Per distinct species: main photo bytes, whether it's here, and gallery bytes here or not.
  const n = names.table.length;
  const main = new Float64Array(n);
  const mainHere = new Uint8Array(n);
  const galleryHere = new Float64Array(n);
  const galleryMissing = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    if (k % SIZES_CHUNK === 0 && k > 0) await yieldToEventLoop();
    const id = local.idByName.get(names.table[k]);
    const entry = id ? store.species[id] : undefined;
    if (!id || !entry) continue;
    main[k] = refBytes(entry);
    mainHere[k] = local.hasMain.has(id) ? 1 : 0;
    for (const [url, pair] of Object.entries(entry.g ?? {})) {
      if (local.hasGallery.has(`${id}|${url}`)) galleryHere[k] += refBytes(pair);
      else galleryMissing[k] += refBytes(pair);
    }
  }
  const out: PhotoSizes = new Map();
  for (let i = 0; i < names.packIds.length; i++) {
    if (i % SIZES_CHUNK === 0 && i > 0) await yieldToEventLoop();
    let missing = 0;
    let missingMain = 0;
    let present = 0;
    for (let j = names.offsets[i]; j < names.offsets[i + 1]; j++) {
      const k = names.ids[j];
      if (mainHere[k]) present += main[k];
      else {
        missing += main[k];
        missingMain += main[k];
      }
      present += galleryHere[k];
      missing += galleryMissing[k];
    }
    out.set(names.packIds[i], { missing, missingMain, present });
  }
  return out;
}

// One shared "no photo sizes", so the status memo below still matches.
const NO_SIZES: Map<string, { missing: number; missingMain: number; present: number }> = new Map();
let statusMemo: {
  index: PackIndex;
  sizes: object | null;
  installedKey: string;
  indexUnavailable: boolean;
  packs: Array<PackIndexEntry & { downloaded: boolean; updateAvailable: boolean }>;
  packsJson: string;
} | null = null;

// Downloaded/update state per pack, shared by the pack list, the updates banner and batches.
// Concurrent callers (the list, the updates check and a batch, all at startup) share one run.
let statusesInFlight: ReturnType<typeof computeStatuses> | null = null;
export function computePackStatuses(): ReturnType<typeof computeStatuses> {
  statusesInFlight ??= computeStatuses().finally(() => {
    statusesInFlight = null;
  });
  return statusesInFlight;
}

async function computeStatuses(): Promise<{
  generatedAt: string;
  packs: Array<PackIndexEntry & { downloaded: boolean; updateAvailable: boolean }>;
  /** Photo sizes aren't in sizeBytes yet: the photo store index is still downloading. */
  sizesPending: boolean;
  /** No copy of the published index at all yet (none fetched, none saved): installed packs come
   *  from this computer and nothing else is offered, with no updates flagged. */
  indexUnavailable: boolean;
  /** The connection to the index host, for the screens' "slow" or "offline" note. */
  remote: RemoteState;
  /** A refresh is still on its way: ask again shortly for the newer list. */
  refreshing: boolean;
  /** How far the refresh's current file has got, for "Getting the list... 31%". */
  progress: { receivedBytes: number; totalBytes: number | null } | null;
  /** `packs` as the list route sends it, serialized once per change. */
  packsJson: string;
}> {
  // Never waits on the network: no copy yet means "unavailable" while one downloads.
  const cached = await fetchPackIndex({ wait: false });
  const indexUnavailable = cached === null;
  const index: PackIndex = cached ?? { generatedAt: "", packs: [] };
  // Photo sizes need the species names only the full index has.
  // Photo sizes need the species names: read from the saved full copy in the background (in a
  // worker), and pending until then.
  const names = packIndexCache?.names ?? null;
  if (!names && !indexUnavailable) void loadSavedNames();
  const { state: remote, refreshing, progress } = packIndexRemoteState();
  const downloadedRes = await pool.query<{
    pack_id: string;
    content_version: string | null;
    region: string | null;
    taxon: string | null;
    species_count: number;
    bytes: string;
  }>(`SELECT pack_id, content_version, region, taxon, species_count, bytes FROM downloaded_packs`);
  const downloadedByPackId = new Map(downloadedRes.rows.map((r) => [r.pack_id, r]));

  // With a photo store, every pack is offered two ways: with its gallery photos, and as ".small"
  // without them. Both install the same checklist.
  // null means "sizes pending": no saved sizes match and the photo store index or the species
  // names (only the full index has them) aren't here yet. Never a checklist-only size as final.
  type Sizes = Map<string, { missing: number; missingMain: number; present: number }>;
  let computed: Sizes | null;
  if (indexUnavailable || !index.photoStore) computed = NO_SIZES;
  else
    computed = await (names ? photoSizes(index, names, remote !== "offline") : savedPhotoSizes(index)).catch((err) => {
      log.warn({ err }, "[packs] couldn't work out pack sizes from the photo store");
      return null;
    });
  const sizes: Sizes = computed ?? NO_SIZES;
  // Thousands of entries: built once per change of index, sizes or installed packs, and reused by
  // every request in between (several arrive together at startup).
  const installedKey = downloadedRes.rows.map((r) => `${r.pack_id}:${r.content_version}`).join("|");
  if (
    statusMemo &&
    statusMemo.index === index &&
    statusMemo.sizes === computed &&
    statusMemo.installedKey === installedKey &&
    statusMemo.indexUnavailable === indexUnavailable
  )
    return {
      generatedAt: index.generatedAt,
      packs: statusMemo.packs,
      packsJson: statusMemo.packsJson,
      sizesPending: computed === null,
      indexUnavailable,
      remote,
      refreshing,
      progress,
    };
  const offered = index.photoStore
    ? index.packs.flatMap((p) => [p, { ...p, id: `${p.id}${SMALL_SUFFIX}`, variant: "small" as const }])
    : index.packs;
  const packs = offered.map((p) => {
    const downloaded = downloadedByPackId.get(p.id);
    const size = sizes.get(basePackId(p.id).id);
    const small = basePackId(p.id).small;
    return {
      ...p,
      ...(size && { sizeBytes: p.sizeBytes + (downloaded ? size.present : small ? size.missingMain : size.missing) }),
      downloaded: downloaded !== undefined,
      // No stored content_version means nothing to compare yet, and a stale index can't say.
      updateAvailable:
        !indexUnavailable && downloaded?.content_version != null && downloaded.content_version !== p.contentVersion,
    };
  });

  // A downloaded pack can be missing from the current index (mid-republish). Local
  // downloaded_packs rows decide what's installed, so those still show.
  const indexedIds = new Set(packs.map((p) => p.id));
  const missingFromIndex = downloadedRes.rows
    .filter((r) => !indexedIds.has(r.pack_id))
    .map((r) => ({
      id: r.pack_id,
      type: (r.pack_id.startsWith("seazone-") ? "seaZone" : "region") as "region" | "seaZone",
      region: r.region ?? undefined,
      seaZone: r.pack_id.startsWith("seazone-") ? (r.region ?? undefined) : undefined,
      taxon: r.taxon,
      sizeBytes: Number(r.bytes),
      speciesCount: r.species_count,
      contentVersion: r.content_version ?? "",
      scientificNames: [],
      url: "",
      downloaded: true,
      // Nothing to compare against.
      updateAvailable: false,
    }));

  const all = [...packs, ...missingFromIndex];
  statusMemo = {
    index,
    sizes: computed,
    installedKey,
    indexUnavailable,
    packs: all,
    // What the list route sends: scientificNames left out (always empty here anyway).
    packsJson: JSON.stringify(all.map(({ scientificNames: _scientificNames, ...p }) => p)),
  };
  return {
    generatedAt: index.generatedAt,
    packs: all,
    packsJson: statusMemo.packsJson,
    sizesPending: computed === null,
    indexUnavailable,
    remote,
    refreshing,
    progress,
  };
}

export async function packIndexRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  // Also for the linked desktop app's key (scope "sync"), which compares the two installs' packs.
  app.get(
    "/offline-packs/index",
    { preValidation: requireScope("sync"), schema: { response: replies(PackList) } },
    async (_request, reply) => {
      try {
        const statuses = await computePackStatuses();
        const head = {
          generatedAt: statuses.generatedAt,
          ...(statuses.sizesPending && { sizesPending: true }),
          ...(statuses.indexUnavailable && { indexUnavailable: true }),
          remote: statuses.remote,
          ...(statuses.refreshing && { indexRefreshing: true }),
          ...(statuses.progress && { indexProgress: statuses.progress }),
          freeBytes: await freeSpace(APP_DATA_DIR),
        };
        // The pack list is serialized once per change (computePackStatuses) and spliced in, so a
        // request doesn't re-serialize thousands of entries on the event loop. A string payload
        // skips Fastify's serializer; the shape is the one PackList describes.
        const body = `${JSON.stringify(head).slice(0, -1)},"packs":${statuses.packsJson}}`;
        return reply.type("application/json").send(body as never);
      } catch (err) {
        return reply.code(503).send({ error: (err as Error).message, code: "pack_index_unavailable" });
      }
    },
  );

  // Small payload so it's cheap to check at app launch without the full index.
  app.get(
    "/offline-packs/updates-summary",
    { preValidation: requireAuth, schema: { response: replies(PackUpdatesSummary) } },
    async (_request, reply) => {
      try {
        const statuses = await computePackStatuses();
        const stale = statuses.packs.filter((p) => p.updateAvailable);
        return {
          updateCount: stale.length,
          totalBytes: stale.reduce((sum, p) => sum + p.sizeBytes, 0),
          packIds: stale.map((p) => p.id),
        };
      } catch (err) {
        return reply.code(503).send({ error: (err as Error).message, code: "pack_index_unavailable" });
      }
    },
  );

  // Greedy set cover: the fewest not-yet-downloaded packs that cover the given species.
  app.post(
    "/offline-packs/recommend",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          { scientificNames: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }) },
          { additionalProperties: false },
        ),
        response: replies(PackRecommendation),
      },
    },
    async (request, reply) => {
      const { scientificNames } = request.body;
      try {
        // Recommending needs each pack's species names: the full index.
        // Needs each pack's species names: the full index, read once in a worker.
        const { index, names } = await packNames();
        const position = new Map(names.packIds.map((id, i) => [id, i]));
        const tableIndex = new Map(names.table.map((name, k) => [name, k]));
        const downloadedRes = await pool.query<{ pack_id: string }>(`SELECT pack_id FROM downloaded_packs`);
        const downloadedIds = new Set(downloadedRes.rows.map((r) => r.pack_id));

        // Worked on as positions in the shared name table; names not in any pack stay uncovered.
        const remaining = new Set(scientificNames);
        const remainingK = new Set<number>();
        for (const name of scientificNames) {
          const k = tableIndex.get(name);
          if (k !== undefined) remainingK.add(k);
        }
        const coverageOf = (packId: string) => {
          const i = position.get(packId);
          if (i === undefined) return 0;
          let count = 0;
          for (let j = names.offsets[i]; j < names.offsets[i + 1]; j++) if (remainingK.has(names.ids[j])) count++;
          return count;
        };
        // Small variants cover the same species as full ones, so only full packs are candidates.
        const candidates = index.packs.filter((p) => !downloadedIds.has(p.id) && (p.variant ?? "full") === "full");
        const picked: Array<{
          id: string;
          region?: string;
          seaZone?: string;
          taxon: string | null;
          sizeBytes: number;
          covers: number;
        }> = [];

        while (remainingK.size > 0) {
          let best: PackIndexEntry | null = null;
          let bestCoverage = 0;
          for (const pack of candidates) {
            if (picked.some((p) => p.id === pack.id)) continue;
            const coverage = coverageOf(pack.id);
            if (coverage > bestCoverage) {
              best = pack;
              bestCoverage = coverage;
            }
          }
          if (!best || bestCoverage === 0) break;
          picked.push({
            id: best.id,
            region: best.region,
            seaZone: best.seaZone,
            taxon: best.taxon ?? null,
            sizeBytes: best.sizeBytes,
            covers: bestCoverage,
          });
          const i = position.get(best.id)!;
          for (const name of namesOf(names, i)) {
            remaining.delete(name);
            remainingK.delete(tableIndex.get(name)!);
          }
        }

        return { recommended: picked, uncovered: [...remaining] };
      } catch (err) {
        return reply.code(503).send({ error: (err as Error).message, code: "pack_index_unavailable" });
      }
    },
  );
}
