// The published pack index: fetching and caching it, and the routes that list packs.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { requireAuth } from "../auth/session.js";
import { withSchemas } from "../lib/schema.js";
import { PACK_INDEX_URL } from "@lifer/core/config.js";
import { fetchPhotoStoreIndex } from "./photoStore.js";
import { log } from "@lifer/core/lib/log.js";

export interface PackIndexEntry {
  id: string;
  type: "region" | "seaZone";
  region?: string;
  seaZone?: string;
  taxon?: string | null;
  // "small" has the same checklist and embeddings as "full" but one reference photo per
  // species. Absent means "full".
  variant?: "full" | "small";
  sizeBytes: number;
  speciesCount: number;
  // Hash of the pack's manifest, so a downloaded pack is recognized as stale when it changes.
  contentVersion: string;
  // Every species in the pack and its bundled provinces, deduplicated. Used by /recommend.
  scientificNames: string[];
  // The pack store shard it's in, the bytes of it that are this pack, and their SHA-256
  // (data-pipeline's pipeline/packStore.ts).
  url: string;
  range?: [number, number];
  sha256?: string;
  // Pack ids (not zone names: a zone has one pack per taxon) of the sea zones a region pack
  // depends on, so the client can group them under their country.
  seaZoneDependencies?: string[];
}

export interface PackIndex {
  generatedAt: string;
  /** Where pack photos are fetched from (offlinePacks/photoStore.ts). */
  photoStore?: { indexUrl: string };
  packs: PackIndexEntry[];
}

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
    const index = (await res.json()) as PackIndex;
    packIndexCache = { at: Date.now(), index };
    return index;
  })().finally(() => {
    packIndexInFlight = null;
  });
  return packIndexInFlight;
}

// Each pack's url comes from the fetched index JSON, so a tampered index could aim this server's
// fetch at an internal service. Packs must share the index's origin.
export function assertTrustedPackUrl(url: string): void {
  if (!PACK_INDEX_URL) throw new Error("No pack index is configured for this instance yet");
  const packOrigin = new URL(url).origin;
  const indexOrigin = new URL(PACK_INDEX_URL).origin;
  if (packOrigin !== indexOrigin) {
    throw new Error(`Refusing to fetch a pack from an untrusted origin: ${packOrigin}`);
  }
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

async function photoSizes(
  index: PackIndex,
  packs: PackIndexEntry[],
): Promise<Map<string, { missing: number; missingMain: number; present: number }>> {
  const out = new Map<string, { missing: number; missingMain: number; present: number }>();
  if (!index.photoStore) return out;
  const store = await fetchPhotoStoreIndex(index.photoStore.indexUrl);
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
  const sizes = await photoSizes(index, index.packs).catch((err) => {
    log.warn({ err }, "[packs] couldn't work out pack sizes from the photo store");
    return new Map<string, { missing: number; missingMain: number; present: number }>();
  });
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

  return { generatedAt: index.generatedAt, packs: [...packs, ...missingFromIndex] };
}

export async function packIndexRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.get("/offline-packs/index", { preValidation: requireAuth, schema: {} }, async (_request, reply) => {
    try {
      const statuses = await computePackStatuses();
      return {
        generatedAt: statuses.generatedAt,
        // scientificNames is left out: the cards don't need it and it's large for big packs.
        packs: statuses.packs.map(({ scientificNames: _scientificNames, ...p }) => p),
      };
    } catch (err) {
      return reply.code(503).send({ error: (err as Error).message, code: "pack_index_unavailable" });
    }
  });

  // Small payload so it's cheap to check at app launch without the full index.
  app.get("/offline-packs/updates-summary", { preValidation: requireAuth, schema: {} }, async (_request, reply) => {
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
  });

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
