// The small catalog-manifest.json published next to the catalog seed (see
// packages/data-pipeline/src/scripts/build-catalog-seed.ts). Older manifests only had
// {version, publishedAt}; newer ones also describe each asset with a sha256.
import { CATALOG_MANIFEST_URL, CATALOG_SEED_URL } from "../config.js";

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
  // The species identification model's vectors (id_model_* tables), fetched once that model is
  // downloaded. Absent from catalogs published before it existed.
  idGalleryEmbeddings?: VectorAsset | null;
  idSpeciesImageEmbeddings?: VectorAsset | null;
  idSpeciesTextEmbeddings?: VectorAsset | null;
}

const MANIFEST_TIMEOUT_MS = 15_000;

export async function fetchCatalogManifest(signal?: AbortSignal): Promise<CatalogManifest> {
  let res: Response;
  try {
    const timeout = AbortSignal.timeout(MANIFEST_TIMEOUT_MS);
    res = await fetch(CATALOG_MANIFEST_URL, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error("Couldn't check for a catalog update: the request timed out. Check this server's network access.");
    }
    throw err;
  }
  if (!res.ok) throw new Error(`Couldn't check for a catalog update: HTTP ${res.status}`);
  return (await res.json()) as CatalogManifest;
}

export function resolveCatalogAssetUrl(assetUrl: string): string {
  return new URL(assetUrl, CATALOG_MANIFEST_URL).toString();
}

export function catalogSeedAsset(manifest: CatalogManifest): { url: string; sha256: string | null } {
  if (manifest.seed) return { url: resolveCatalogAssetUrl(manifest.seed.url), sha256: manifest.seed.sha256 };
  return { url: CATALOG_SEED_URL, sha256: null };
}
