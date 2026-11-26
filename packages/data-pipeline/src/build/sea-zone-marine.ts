// Sea zone checklists for marine life other than fish and marine mammals (nudibranchs and other
// molluscs, corals, anemones and jellies, sea stars and urchins, crustaceans, sponges and
// tunicates, sea turtles, sea snakes), from OBIS checklists of each zone's polygon.
//
// OBIS (Ocean Biodiversity Information System, obis.org) answers a species list with record counts
// for a WKT polygon, holds marine taxa only (WoRMS-backed, with habitat flags) and so never mixes in
// the land snails, crayfish and tortoises a bounding box over a coast would. iNaturalist has no
// places for the sea zones, so it only confirms rarely recorded species here.
import type { ZoneSpeciesRow } from "./sea-basins.js";

/** Catalog classes this step owns on sea_zone_species. Fish and marine mammals come from
 *  compute-sea-zones-offline.ts, which leaves these rows alone. */
export const MARINE_EXTRA_CLASSES = [
  "nudibranchs",
  "marine_mollusks",
  "cephalopoda",
  "corals",
  "jellies_and_anemones",
  "echinodermata",
  "crustacea",
  "sponges_tunicates_other",
  "testudines",
  "squamata",
] as const;

/** The OBIS (WoRMS) groups asked for per zone; together they cover MARINE_EXTRA_CLASSES. */
export const OBIS_GROUPS = [
  "Mollusca",
  "Cnidaria",
  "Echinodermata",
  "Crustacea",
  "Porifera",
  "Tunicata",
  "Testudines",
  "Squamata",
] as const;

// A zone keeps a species with this many OBIS records in its polygon...
export const MARINE_MIN_RECORDS = 5;
// ...or with at least one there and this many iNaturalist research-grade observations in a
// coastal place next to the zone (a photographed species OBIS has few records of).
export const INAT_CONFIRM_MIN_OBSERVATIONS = 3;

export interface ObisChecklistRow {
  scientificName: string;
  acceptedNameUsage?: string | null;
  taxonRank?: string | null;
  records: number;
  is_marine?: boolean | null;
  is_brackish?: boolean | null;
  is_freshwater?: boolean | null;
  is_terrestrial?: boolean | null;
}

/** "Callyspongia (Cladochalina) plicifera" and subspecies to the catalog's binomial. */
export function binomial(name: string): string | null {
  const words = name
    .replace(/\([^)]*\)/g, " ")
    .trim()
    .split(/\s+/);
  return words.length >= 2 ? `${words[0]} ${words[1]}` : null;
}

/** Only fresh water or land by OBIS's WoRMS flags; unknown flags never count against a species. */
export function freshwaterOrLandOnly(r: ObisChecklistRow): boolean {
  if (r.is_marine === true || r.is_brackish === true) return false;
  return r.is_freshwater === true || r.is_terrestrial === true;
}

/** Species binomials (name and accepted name) OBIS flags marine or brackish. */
export function marineBinomials(rows: ObisChecklistRow[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows)
    if (r.is_marine || r.is_brackish)
      for (const n of [r.scientificName, r.acceptedNameUsage]) {
        const b = n ? binomial(n) : null;
        if (b) out.add(b);
      }
  return out;
}

/** Records per catalog species in one zone, summed over OBIS rows (OBIS lists subspecies apart).
 *  Species OBIS flags marine or brackish are added to `marine`. */
export function tallyZone(
  rows: ObisChecklistRow[],
  speciesIdByName: Map<string, string>,
  marine?: Set<string>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    if (r.taxonRank !== "Species" && r.taxonRank !== "Subspecies") continue;
    if (freshwaterOrLandOnly(r)) continue;
    const id = [r.scientificName, r.acceptedNameUsage]
      .map((n) => (n ? binomial(n) : null))
      .map((n) => (n ? speciesIdByName.get(n) : undefined))
      .find((v) => v !== undefined);
    if (!id) continue;
    out.set(id, (out.get(id) ?? 0) + r.records);
    if (r.is_marine || r.is_brackish) marine?.add(id);
  }
  return out;
}

/** The rows a zone keeps before the basin check: well recorded, or recorded and photographed
 *  next to it. */
export function keepCandidates(
  zone: number,
  tally: Map<string, number>,
  inatConfirmed: (speciesId: string) => boolean,
): ZoneSpeciesRow[] {
  const out: ZoneSpeciesRow[] = [];
  for (const [speciesId, recordCount] of tally)
    if (recordCount >= MARINE_MIN_RECORDS || (recordCount >= 1 && inatConfirmed(speciesId)))
      out.push({ zone, speciesId, recordCount });
  return out;
}
