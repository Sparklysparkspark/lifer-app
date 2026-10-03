// Link to iNaturalist's live map for one species within a region's bounding box, to see sightings
// newer than the offline pack's snapshot.
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
