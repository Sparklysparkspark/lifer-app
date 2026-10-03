// Kept apart from lib/pmtiles.ts so checking for the basemap doesn't pull maplibre into the
// startup bundle.
export const PMTILES_URL = "/maps/world-z8.pmtiles";

// The basemap is a large optional download, so check before letting maplibre fail on a 404.
export async function checkPmtilesAvailable(): Promise<boolean> {
  try {
    const res = await fetch(PMTILES_URL, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}
