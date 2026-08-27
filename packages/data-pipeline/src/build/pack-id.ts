// Single source of truth for a pack's filename/id — previously computed inline (twice, slightly
// differently) in build-region-pack.ts, and re-derived via a regex-strip guess in
// apps/api/src/offlinePacks/routes.ts's seaZoneDependencies handling. Both the pack builder and
// the index builder (build-pack-index.ts) now import from here, so a pack's id is always
// exactly "its own filename minus the .pack.tar.gz suffix," never re-guessed.
export function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function regionPackFileName(regionName: string, taxon: string | null): string {
  const suffix = taxon ? `-${taxon}` : "";
  return `${sanitize(regionName).toLowerCase()}${suffix}.pack.tar.gz`;
}

export function seaZonePackFileName(zoneName: string): string {
  return `seazone-${sanitize(zoneName).toLowerCase()}.pack.tar.gz`;
}

export function packIdFromFileName(fileName: string): string {
  return fileName.replace(/\.pack\.tar\.gz$/, "");
}
