// Kept apart from lib/pmtiles.ts so checking for the basemap doesn't pull maplibre into the
// startup bundle.
import { api } from "../api/client";

export const PMTILES_URL = "/maps/world-z8.pmtiles";
export const RELIEF_URL = "/maps/relief-z5.pmtiles";

// Set by the availability check below; the relief file is optional, so maps draw flat without it.
let reliefDownloaded = false;
export const reliefAvailable = () => reliefDownloaded;
// Countries with a detailed map downloaded, drawn from zoom 9 inside their borders.
let detailCodes: string[] = [];
export const detailMaps = () => detailCodes;
export const detailMapUrl = (code: string) => `/maps/detail/${code}.pmtiles`;

// The basemap is a large optional download. Asking the server, rather than requesting the file,
// keeps a map that was never downloaded from showing up as a failed request in the console.
export async function checkPmtilesAvailable(): Promise<boolean> {
  try {
    const status = await api.get("/settings/map/status");
    reliefDownloaded = status.reliefDownloaded;
    detailCodes = status.detail ?? [];
    return status.downloaded;
  } catch {
    return false;
  }
}
