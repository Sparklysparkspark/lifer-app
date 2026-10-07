// Kept apart from lib/pmtiles.ts so checking for the basemap doesn't pull maplibre into the
// startup bundle.
import { api } from "../api/client";

export const PMTILES_URL = "/maps/world-z8.pmtiles";

// The basemap is a large optional download. Asking the server, rather than requesting the file,
// keeps a map that was never downloaded from showing up as a failed request in the console.
export async function checkPmtilesAvailable(): Promise<boolean> {
  try {
    const status = await api.get<{ downloaded: boolean }>("/settings/map/status");
    return status.downloaded;
  } catch {
    return false;
  }
}
