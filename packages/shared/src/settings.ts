import type { FolderLevel } from "./folderLayout.js";
import type { LibraryRoot } from "./storageVolume.js";
import type { LoadProgress } from "./job.js";

// GET /settings: the signed-in account's preferences plus a few per-install facts. The web app
// checks the route's generated response type against this one, so the two can't drift apart.
/** Main name + Also show ("other" is whichever of common/scientific isn't the main name). */
export interface SpeciesNameDisplay {
  main: "common" | "scientific";
  also: Array<"other" | "aba" | "ebird">;
}

export interface SettingsResponse {
  // Where originals are filed, outermost folder level first.
  folderLayout: FolderLevel[];
  hideObscureSpecies: boolean;
  speciesSuggestEnabled: boolean;
  anyTaxaSearchEnabled: boolean;
  // Per install, shared by every account on it.
  fetchWithheldPhotos: boolean;
  technicalDiving: boolean;
  speciesNamingStyles: string[];
  // The View menu's species name choice, or null when never set; share pages use it too.
  speciesNameDisplay: SpeciesNameDisplay | null;
  // In-app tips: whether they show at all, and the ids of the ones already seen.
  tipsEnabled: boolean;
  tipsSeen: string[];
  // The interface language (a locale code), or null for automatic.
  locale: string | null;
  abaCodesAvailable: boolean;
  // The photo library folder (DATA_DIR) as the API sees it.
  dataDir: string;
  deploymentMode: "desktop" | "server";
  // "running" while a fresh server is still loading its species/region catalog.
  catalogLoading: "running" | "failed" | null;
  // How far a catalog load has got, for a time estimate; null when none is running.
  catalogProgress?: LoadProgress | null;
  // Admin-declared extra library folders; always [] on desktop.
  libraryRoots: LibraryRoot[];
}
