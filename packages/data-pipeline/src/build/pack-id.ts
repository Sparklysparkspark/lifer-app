// Single source of truth for a pack's filename and id, shared by the pack builder and
// build-pack-index.ts: a pack's id is always its filename minus the .pack.tar.gz suffix.
export function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

// "small" ships the same checklist/embeddings as "full" but skips the reference-photo gallery
// (only the featured photo per species); gallery photos are fetched on demand once online.
export type PackVariant = "full" | "small";

function variantSuffix(variant: PackVariant): string {
  return variant === "small" ? ".small" : "";
}

export function regionPackFileName(regionName: string, taxon: string | null, variant: PackVariant = "full"): string {
  const suffix = taxon ? `-${taxon}` : "";
  return `${sanitize(regionName).toLowerCase()}${suffix}${variantSuffix(variant)}.pack.tar.gz`;
}

export function seaZonePackFileName(zoneName: string, taxon: string | null, variant: PackVariant = "full"): string {
  const suffix = taxon ? `-${taxon}` : "";
  return `seazone-${sanitize(zoneName).toLowerCase()}${suffix}${variantSuffix(variant)}.pack.tar.gz`;
}

export function packIdFromFileName(fileName: string): string {
  return fileName.replace(/\.pack\.tar\.gz$/, "");
}
