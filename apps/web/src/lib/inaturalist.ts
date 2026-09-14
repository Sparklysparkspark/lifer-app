// Shared by SpeciesHotspotMap.tsx (clustered locations) and SpeciesDetailPage.tsx (the
// widespread case, which shows no map) — both need the same "check what's been seen more
// recently than this pack's own snapshot" link into iNaturalist's live map, scoped to this
// exact region's bounding box plus the species.
export function buildInaturalistObservationsUrl(boundaryGeoJson: unknown, scientificName: string): string | null {
  const bbox = (boundaryGeoJson as { bbox?: [number, number, number, number] } | null)?.bbox;
  if (!bbox) return null;
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const params = new URLSearchParams({
    taxon_name: scientificName,
    swlat: String(minLat),
    swlng: String(minLon),
    nelat: String(maxLat),
    nelng: String(maxLon),
    subview: "map",
  });
  return `https://www.inaturalist.org/observations?${params.toString()}`;
}
