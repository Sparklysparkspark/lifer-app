// The small catalog-manifest.json published next to the catalog seed, describing each asset.
import { fetchPatient, HttpStatusError, retrying } from "../lib/remoteFetch.js";
import { CATALOG_MANIFEST_URL, CATALOG_SEED_URL } from "@lifer/core/config.js";

export interface CatalogAsset {
  // Relative to the manifest's own URL (or absolute).
  url: string;
  sha256: string;
  bytes: number;
}

export type VectorAsset = CatalogAsset & { modelVersion: string; rowCount: number };

export interface CatalogManifest {
  version: number;
  publishedAt: string;
  seed?: CatalogAsset;
  galleryEmbeddings?: VectorAsset | null;
  speciesImageEmbeddings?: VectorAsset | null;
  speciesTextEmbeddings?: VectorAsset | null;
  // The identification model's vectors, fetched once that model is downloaded. Optional.
  idGalleryEmbeddings?: VectorAsset | null;
  idSpeciesImageEmbeddings?: VectorAsset | null;
  idSpeciesTextEmbeddings?: VectorAsset | null;
}

const MANIFEST_TOTAL_MS = 60_000;

export async function fetchCatalogManifest(signal?: AbortSignal): Promise<CatalogManifest> {
  // Patient with one retry: a weak signal takes longer, it isn't "no update".
  let got: Awaited<ReturnType<typeof fetchPatient>>;
  try {
    got = await retrying(
      async () => {
        const r = await fetchPatient(CATALOG_MANIFEST_URL, { totalMs: MANIFEST_TOTAL_MS, signal });
        if (!r.res.ok) throw new HttpStatusError(r.res.status, "the catalog manifest");
        return r;
      },
      { attempts: 2, signal },
    );
  } catch (err) {
    if (err instanceof HttpStatusError)
      throw new Error(`Couldn't check for a catalog update: HTTP ${err.status}`, { cause: err });
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error("Couldn't check for a catalog update: the connection is too slow right now. Try again later.", {
        cause: err,
      });
    }
    throw err;
  }
  return JSON.parse(got.body.toString("utf8")) as CatalogManifest;
}

export function resolveCatalogAssetUrl(assetUrl: string): string {
  return new URL(assetUrl, CATALOG_MANIFEST_URL).toString();
}

export function catalogSeedAsset(manifest: CatalogManifest): { url: string; sha256: string | null } {
  if (manifest.seed) return { url: resolveCatalogAssetUrl(manifest.seed.url), sha256: manifest.seed.sha256 };
  return { url: CATALOG_SEED_URL, sha256: null };
}
