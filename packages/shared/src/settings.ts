import type { LibraryRoot } from "./storageVolume.js";

// GET /settings: the signed-in account's preferences plus a few per-install facts. The web app
// checks the route's generated response type against this one, so the two can't drift apart.
export interface SettingsResponse {
  organizeOriginalsByYear: boolean;
  organizeOriginalsByLocation: boolean;
  hideObscureSpecies: boolean;
  speciesSuggestEnabled: boolean;
  anyTaxaSearchEnabled: boolean;
  // Per install, shared by every account on it.
  fetchWithheldPhotos: boolean;
  technicalDiving: boolean;
  speciesNamingStyles: string[];
  // The interface language (a locale code), or null for automatic.
  locale: string | null;
  abaCodesAvailable: boolean;
  // The photo library folder (DATA_DIR) as the API sees it.
  dataDir: string;
  deploymentMode: "desktop" | "server";
  // "running" while a fresh server is still loading its species/region catalog.
  catalogLoading: "running" | "failed" | null;
  // Admin-declared extra library folders; always [] on desktop.
  libraryRoots: LibraryRoot[];
}
