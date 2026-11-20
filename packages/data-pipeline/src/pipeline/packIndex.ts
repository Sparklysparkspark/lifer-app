// The shape of pack-index.json, shared by the pack builder and the pack store writer.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { httpFetch } from "@lifer/core/lib/http.js";
import { GITHUB_REPO, INDEX_RELEASE_TAG } from "../build/release-groups.js";
import { expectShape, isArrayOf, isRecord } from "../lib/jsonGuards.js";
export interface IndexPack {
  id: string;
  type: "region" | "seaZone";
  region?: string;
  seaZone?: string;
  taxon?: string | null;
  variant?: "full" | "small";
  sizeBytes: number;
  speciesCount: number;
  contentVersion: string;
  scientificNames: string[];
  /** The pack store shard holding it, with `range` [offset, length] and the archive's `sha256`
   *  (pipeline/packStore.ts). */
  url: string;
  range?: [number, number];
  sha256?: string;
  format?: number;
  seaZoneDependencies?: string[];
}
export interface PackIndex {
  generatedAt: string;
  packs: IndexPack[];
}

/** pack-index.json: every pack has the fields publishing and installs key on. The index decides
 *  what a publish deletes, so a truncated or error body must never read as "nothing published". */
export function isPackIndex(v: unknown): v is PackIndex {
  return (
    isRecord(v) &&
    typeof v.generatedAt === "string" &&
    isArrayOf(
      v.packs,
      (p): p is IndexPack =>
        isRecord(p) &&
        typeof p.id === "string" &&
        (p.type === "region" || p.type === "seaZone") &&
        typeof p.speciesCount === "number" &&
        typeof p.contentVersion === "string" &&
        typeof p.url === "string" &&
        isArrayOf(p.scientificNames, (n): n is string => typeof n === "string"),
    )
  );
}

// Retried, so one dropped connection doesn't fail the whole stage. Only a 404 means nothing is
// published: any other failure throws, since an empty index would drop every published pack.
export async function fetchPublishedIndex(): Promise<PackIndex> {
  let res: Response;
  try {
    res = await httpFetch(`https://github.com/${GITHUB_REPO}/releases/download/${INDEX_RELEASE_TAG}/pack-index.json`, {
      timeoutMs: 120_000,
      maxRetries: 4,
      retryServerErrors: true,
      backoffBaseMs: 5000,
    });
  } catch (err) {
    throw new Error(`Couldn't fetch the published pack index: ${(err as Error)?.message ?? err}`, { cause: err });
  }
  if (res.status === 404) return { generatedAt: new Date(0).toISOString(), packs: [] };
  if (!res.ok) throw new Error(`Couldn't fetch the published pack index: HTTP ${res.status}`);
  return expectShape(await res.json(), isPackIndex, "published pack index");
}

/** pack-index-lite.json: the index without species names, which are most of its size (about
 *  22 MB in full). Installs fetch it first so a weak signal gets the list in reasonable time,
 *  then the full index for photo sizes and recommendations. */
export function liteIndex<T extends PackIndex>(
  index: T,
): Omit<T, "packs"> & { packs: Array<Omit<IndexPack, "scientificNames">> } {
  return { ...index, packs: index.packs.map(({ scientificNames: _scientificNames, ...p }) => p) };
}

/** Writes pack-index.json and pack-index-lite.json side by side; the publish uploads both. */
export function writePackIndexFiles(dir: string, index: PackIndex): void {
  writeFileSync(path.join(dir, PACK_INDEX_FILE), JSON.stringify(index, null, 2));
  writeFileSync(path.join(dir, PACK_INDEX_LITE_FILE), JSON.stringify(liteIndex(index)));
}

export const PACK_INDEX_FILE = "pack-index.json";
export const PACK_INDEX_LITE_FILE = "pack-index-lite.json";
