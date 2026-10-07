// API response shapes for GET /api/regions and /api/regions/:id/species. region.ts holds the
// data-pipeline row shape.

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
   *  POST /regions/:id/drill-down). False means "not attempted," not "none exist." */
  hasChildren: boolean;
  /** False for purely organizational hub nodes with no GADM code of their own (World, the
   *  continents). Their checklist would be every species on Earth, so the UI shows only children. */
  hasScopedChecklist: boolean;
  /** Natural Earth's SOV_A3 sovereignty-group code (migration 065), country rows only. A country and
   *  its territories share one code (e.g. the US and Puerto Rico are "US1") so the picker can group them. */
  sovereigntyGroup: string | null;
  /** Country rows only (migration 066): true for a dependency or territory (Puerto Rico, New
   *  Caledonia, ...), so the picker's main list shows only sovereign states. */
  isSovereignDependency: boolean;
}

export interface RegionStats {
  total: number;
  collected: number;
  seen: number;
}

export interface RegionSpeciesResult {
  /** True when the region's pack isn't downloaded yet. Self-hosted installs never compute a
   *  checklist live, so the catalog's checklist exists only once its pack is downloaded. Until
   *  then `items` holds only what's yours there: species you photographed in the region and ones
   *  you added to its checklist yourself. */
  needsPack?: boolean;
  region: {
    id: string;
    name: string;
    ebirdRegionCode: string | null;
    boundaryGeoJson: unknown | null;
    hasChildren: boolean;
    /** True for a country-level region (has a GADM code to drill down from). */
    canDrillDown: boolean;
  };
  stats: RegionStats;
  items: CollectionItem[];
  /** True when a `?taxon=` filter was requested and that taxon's pack isn't downloaded for this
   *  region, though some other pack is (hence not `needsPack`). Lets the UI tell "not installed"
   *  apart from "genuinely empty here". */
  taxonPackMissing?: boolean;
}

export type RegionSpeciesResponse = RegionSpeciesResult;

export interface EbirdImportSummary {
  totalRows: number;
  uniqueSpecies: number;
  matched: number;
  alreadySeenOrCollected: number;
  unmatched: number;
}
