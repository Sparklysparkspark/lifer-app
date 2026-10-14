// The published pack index: fetching and caching it, and the routes that list packs.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { requireAuth } from "../auth/session.js";
import { replies, withSchemas } from "../lib/schema.js";
import { PackList, PackRecommendation, PackUpdatesSummary } from "./responses.js";
import { PACK_INDEX_URL } from "@lifer/core/config.js";
import { fetchPhotoStoreIndex, lastPhotoStoreIndex } from "./photoStore.js";
import { PackIndexSchema, parseRemoteJson, type PackIndex, type PackIndexEntry } from "./schemas.js";
import { log } from "@lifer/core/lib/log.js";

export type { PackIndex, PackIndexEntry } from "./schemas.js";
export { assertTrustedPackUrl } from "./packPaths.js";

/** A ".small" pack id is the same pack installed without gallery photos. */
export const SMALL_SUFFIX = ".small";
export function basePackId(id: string): { id: string; small: boolean } {
  return id.endsWith(SMALL_SUFFIX) ? { id: id.slice(0, -SMALL_SUFFIX.length), small: true } : { id, small: false };
}

// The index is several MB, so it's cached for a few minutes and shared between concurrent
// requests. A pack download asks for a fresh copy so it installs the latest version.
const PACK_INDEX_TTL_MS = 15 * 60_000;
let packIndexCache: { at: number; index: PackIndex } | null = null;
let packIndexInFlight: Promise<PackIndex> | null = null;

export async function fetchPackIndex(opts: { fresh?: boolean } = {}): Promise<PackIndex> {
  if (!PACK_INDEX_URL) throw new Error("No pack index is configured for this instance yet");
  if (!opts.fresh && packIndexCache && Date.now() - packIndexCache.at < PACK_INDEX_TTL_MS) return packIndexCache.index;
  if (packIndexInFlight) return packIndexInFlight;
  packIndexInFlight = (async () => {
    const res = await fetch(PACK_INDEX_URL!, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Couldn't fetch the pack index (${res.status})`);
    const index = parseRemoteJson(PackIndexSchema, await res.json(), "pack index");
    packIndexCache = { at: Date.now(), index };
    return index;
  })().finally(() => {
    packIndexInFlight = null;
  });
  return packIndexInFlight;
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

/** Photo bytes per pack, or null while the photo store index is still downloading. */
async function photoSizes(
  index: PackIndex,
  packs: PackIndexEntry[],
): Promise<Map<string, { missing: number; missingMain: number; present: number }> | null> {
  const out = new Map<string, { missing: number; missingMain: number; present: number }>();
  if (!index.photoStore) return out;
  const indexUrl = index.photoStore.indexUrl;
  const fetching = fetchPhotoStoreIndex(indexUrl);
  // Handled below when awaited; this keeps a failure after the wait from going unhandled.
  fetching.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const store =
    (await Promise.race([
      fetching,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), COLD_PHOTO_INDEX_WAIT_MS);
      }),
    ]).finally(() => clearTimeout(timer))) ?? lastPhotoStoreIndex(indexUrl);
  if (!store) {
    fetching.catch((err) => log.warn({ err }, "[packs] couldn't fetch the pack photo index"));
    return null;
  }
  const local = await localPhotoState();
  const refBytes = (pair?: { d?: [number, number, number, string]; t?: [number, number, number, string] }) =>
    (pair?.d?.[2] ?? 0) + (pair?.t?.[2] ?? 0);
  for (const p of packs) {
    let missing = 0;
    let missingMain = 0;
    let present = 0;
    for (const name of p.scientificNames ?? []) {
      const id = local.idByName.get(name);
      const entry = id ? store.species[id] : undefined;
      if (!id || !entry) continue;
      const main = refBytes(entry);
      if (local.hasMain.has(id)) present += main;
      else {
        missing += main;
        missingMain += main;
      }
      for (const [url, pair] of Object.entries(entry.g ?? {})) {
        if (local.hasGallery.has(`${id}|${url}`)) present += refBytes(pair);
        else missing += refBytes(pair);
      }
    }
    out.set(p.id, { missing, missingMain, present });
  }
  return out;
}

// Downloaded/update state per pack, shared by the pack list, the updates banner and batches.
export async function computePackStatuses(): Promise<{
  generatedAt: string;
  packs: Array<PackIndexEntry & { downloaded: boolean; updateAvailable: boolean }>;
  /** Photo sizes aren't in sizeBytes yet: the photo store index is still downloading. */
  sizesPending: boolean;
}> {
  const index = await fetchPackIndex();
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
  const computed = await photoSizes(index, index.packs).catch((err) => {
    log.warn({ err }, "[packs] couldn't work out pack sizes from the photo store");
    return new Map<string, { missing: number; missingMain: number; present: number }>();
  });
  const sizes = computed ?? new Map<string, { missing: number; missingMain: number; present: number }>();
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
      // No stored content_version means nothing to compare yet, so no update is flagged.
      updateAvailable: downloaded?.content_version != null && downloaded.content_version !== p.contentVersion,
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

  return { generatedAt: index.generatedAt, packs: [...packs, ...missingFromIndex], sizesPending: computed === null };
}

export async function packIndexRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.get(
    "/offline-packs/index",
    { preValidation: requireAuth, schema: { response: replies(PackList) } },
    async (_request, reply) => {
      try {
        const statuses = await computePackStatuses();
        return {
          generatedAt: statuses.generatedAt,
          ...(statuses.sizesPending && { sizesPending: true }),
          // scientificNames is left out: the cards don't need it and it's large for big packs.
          packs: statuses.packs.map(({ scientificNames: _scientificNames, ...p }) => p),
        };
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
        const index = await fetchPackIndex();
        const downloadedRes = await pool.query<{ pack_id: string }>(`SELECT pack_id FROM downloaded_packs`);
        const downloadedIds = new Set(downloadedRes.rows.map((r) => r.pack_id));

        const remaining = new Set(scientificNames);
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

        while (remaining.size > 0) {
          let best: PackIndexEntry | null = null;
          let bestCoverage = 0;
          for (const pack of candidates) {
            if (picked.some((p) => p.id === pack.id)) continue;
            const coverage = pack.scientificNames.filter((n) => remaining.has(n)).length;
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
          for (const name of best.scientificNames) remaining.delete(name);
        }

        return { recommended: picked, uncovered: [...remaining] };
      } catch (err) {
        return reply.code(503).send({ error: (err as Error).message, code: "pack_index_unavailable" });
      }
    },
  );
}
