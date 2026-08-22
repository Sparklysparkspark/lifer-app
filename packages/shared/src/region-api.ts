// API response shapes for GET /api/regions and /api/regions/:id/species — kept separate
// from region.ts (the Phase-1 data-pipeline row shape, a different concern) per Phase 3.

import type { CollectionItem } from "./collection.js";

export interface RegionSummary {
  id: string;
  name: string;
  parentId: string | null;
  ebirdRegionCode: string | null;
  /** Natural Earth boundary feature (public domain), for the region map. Null for the
   *  continent-level row, which has no boundary fetched (see build-regions.ts). */
  boundaryGeoJson: unknown | null;
  /** Whether province/state-level child regions have been drilled into yet (see
   *  POST /regions/:id/drill-down) — false just means "not attempted," not "none exist." */
  hasChildren: boolean;
  /** False for purely organizational hub nodes with no GADM code of their own (World, the
   *  continents) — GET /regions/:id/species returns literally every species on Earth for
   *  those, since there's no occurrence filter to scope it. Lets the UI show just the
   *  drill-down children for a hub node instead of quietly fetching/rendering that. */
  hasScopedChecklist: boolean;
}

export interface RegionStats {
  total: number;
  collected: number;
  seen: number;
}

export interface RegionSpeciesResponse {
  region: {
    id: string;
    name: string;
    ebirdRegionCode: string | null;
    boundaryGeoJson: unknown | null;
    hasChildren: boolean;
    /** True for a country-level region (has a GADM code to drill down from) — World and
     *  continent rows have none, so no "show provinces/states" button makes sense there. */
    canDrillDown: boolean;
  };
  stats: RegionStats;
  items: CollectionItem[];
}

export interface EbirdImportSummary {
  totalRows: number;
  uniqueSpecies: number;
  matched: number;
  alreadySeenOrCollected: number;
  unmatched: number;
}
