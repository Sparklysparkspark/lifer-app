// Single source of truth for a pack's filename/id — previously computed inline (twice, slightly
// differently) in build-region-pack.ts, and re-derived via a regex-strip guess in
// apps/api/src/offlinePacks/routes.ts's seaZoneDependencies handling. Both the pack builder and
// the index builder (build-pack-index.ts) now import from here, so a pack's id is always
// exactly "its own filename minus the .pack.tar.gz suffix," never re-guessed.
export function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

// "small" ships the same checklist/embeddings as "full" but skips the reference-photo gallery
// (only the single featured photo per species), a much smaller download for users who accept
// fetching extra gallery photos on demand once online, per species.
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
