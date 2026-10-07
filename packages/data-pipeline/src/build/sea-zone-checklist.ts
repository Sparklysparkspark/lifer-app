// A sea zone's checklist from point records, the offline counterpart of ensureSeaZoneComputed
// (packages/core/src/regions/compute/seaZones.ts): the same record threshold, inland check and
// geographic-outlier check, applied to tallies built from the GBIF country downloads instead of
// live polygon searches. Two rules only this path has, from WoRMS habitats: freshwater-only
// species are left off, and a marine species flagged as an outlier stays when a neighbouring zone
// has it well recorded. See compute-sea-zones-offline.ts for what else differs.
import type { Point } from "@lifer/core/lib/geometry.js";
import {
  FISH_MIN_RECORDS,
  GEOGRAPHIC_OUTLIER_MAX_LOCAL_RECORDS,
  looksLikeGeographicOutlier,
} from "@lifer/core/regions/buildRegionSpecies.js";

// The live path judges a species from GBIF's first 20 records in the zone (limit=20 in
// fetchRecordSampleForParam), so the same number of points is kept per zone and species.
export const SAMPLE_POINTS = 20;

export interface SpeciesTally {
  recordCount: number;
  // Distinct record locations, first SAMPLE_POINTS seen.
  points: Point[];
}

/** Record counts and sample points per zone and catalog species, kept small whatever the input:
 *  one entry per pair, at most SAMPLE_POINTS points each. */
export class SeaZoneTally {
  readonly byZone = new Map<number, Map<string, SpeciesTally>>();

  add(zone: number, speciesId: string, point: Point, recordCount: number): void {
    let species = this.byZone.get(zone);
    if (!species) this.byZone.set(zone, (species = new Map()));
    let tally = species.get(speciesId);
    if (!tally) species.set(speciesId, (tally = { recordCount: 0, points: [] }));
    tally.recordCount += recordCount;
    if (tally.points.length < SAMPLE_POINTS && !tally.points.some((p) => p[0] === point[0] && p[1] === point[1])) {
      tally.points.push(point);
    }
  }
}

export interface ChecklistInputs {
  // Species without a photo on a high tier get the checks at any record count, as in the live path.
  highTierNoPhoto: Set<string>;
  // A species' record count across all of GBIF; missing counts never flag a species as an outlier.
  globalCount: Map<string, number>;
  looksInland: (points: Point[]) => Promise<boolean>;
  // Species WoRMS records only in fresh water or on land (never marine or brackish): left off at
  // any record count, since a sea zone's list is for what lives in the sea.
  freshwaterOnly?: Set<string>;
  // Species WoRMS records as marine or brackish.
  marineOrBrackish?: Set<string>;
  // Whether a species is well recorded (more than GEOGRAPHIC_OUTLIER_MAX_LOCAL_RECORDS) in a zone
  // next to this one. A marine species with only a sliver of its records here is then at the edge
  // of its range (a basking shark in the Adriatic), not a misidentification or a record from the
  // wrong ocean.
  establishedNearby?: (speciesId: string) => boolean;
}

/** The species a zone keeps, with their record counts. */
export async function decideZoneChecklist(
  tallies: Map<string, SpeciesTally>,
  inputs: ChecklistInputs,
): Promise<Array<{ speciesId: string; recordCount: number }>> {
  const kept: Array<{ speciesId: string; recordCount: number }> = [];
  for (const [speciesId, { recordCount, points }] of tallies) {
    if (recordCount < FISH_MIN_RECORDS) continue;
    if (inputs.freshwaterOnly?.has(speciesId)) continue;
    const needsScrutiny = recordCount <= GEOGRAPHIC_OUTLIER_MAX_LOCAL_RECORDS || inputs.highTierNoPhoto.has(speciesId);
    if (needsScrutiny) {
      if (await inputs.looksInland(points)) continue;
      if (
        recordCount <= GEOGRAPHIC_OUTLIER_MAX_LOCAL_RECORDS &&
        looksLikeGeographicOutlier(recordCount, inputs.globalCount.get(speciesId) ?? 0) &&
        !(inputs.marineOrBrackish?.has(speciesId) && inputs.establishedNearby?.(speciesId))
      ) {
        continue;
      }
    }
    kept.push({ speciesId, recordCount });
  }
  return kept;
}
