import type { RegionSummary, TaxonClass } from "@lifer/shared";
import type { PackStatusEntry } from "./packIndex";
import { addToSetIn, groupInto } from "./groupInto";

// Natural Earth puts these under North America; a frontend-only pseudo-continent groups them for browsing.
const CENTRAL_AMERICA_COUNTRY_NAMES = new Set([
  "Guatemala",
  "Belize",
  "Honduras",
  "El Salvador",
  "Nicaragua",
  "Costa Rica",
  "Panama",
]);
export const CENTRAL_AMERICA_CONTINENT_ID = "central-america";
const CENTRAL_AMERICA_CONTINENT: RegionSummary = {
  id: CENTRAL_AMERICA_CONTINENT_ID,
  name: "Central America",
  parentId: null,
  ebirdRegionCode: null,
  boundaryGeoJson: null,
  hasChildren: false,
  hasScopedChecklist: false,
  sovereigntyGroup: null,
  isSovereignDependency: false,
};

/** Which continent group a country displays under, shared by the grouping and search. */
export function continentIdForCountry(country: RegionSummary): string | null {
  if (CENTRAL_AMERICA_COUNTRY_NAMES.has(country.name)) return CENTRAL_AMERICA_CONTINENT_ID;
  return country.parentId;
}

export interface RegionGrouping {
  /** World's children, with Central America inserted right after North America. */
  continents: RegionSummary[];
  /** Primary countries per continent group, sorted by name. */
  countriesByContinent: Map<string, RegionSummary[]>;
  /** Territories (sovereign dependencies) per real continent, sorted by name. */
  territoriesByContinent: Map<string, RegionSummary[]>;
  /** A sovereign country's territories (same sovereignty group, e.g. the US and Puerto Rico). */
  territoriesByCountryId: Map<string, RegionSummary[]>;
}

const byName = (a: RegionSummary, b: RegionSummary) => a.name.localeCompare(b.name);

/** How both pack pickers (Offline packs and onboarding) group the region list for browsing. */
export function groupRegions(regions: RegionSummary[]): RegionGrouping {
  const world = regions.find((r) => r.parentId === null);
  const real = regions.filter((r) => world && r.parentId === world.id);
  const northAmericaIndex = real.findIndex((c) => c.name === "North America");
  // Right after North America, since that's where these countries would otherwise be found.
  const continents =
    northAmericaIndex === -1
      ? real
      : [...real.slice(0, northAmericaIndex + 1), CENTRAL_AMERICA_CONTINENT, ...real.slice(northAmericaIndex + 1)];
  const continentIds = new Set(real.map((c) => c.id));

  const countriesByContinent = new Map<string, RegionSummary[]>();
  const territoriesByContinent = new Map<string, RegionSummary[]>();
  const bySovereigntyGroup = new Map<string, RegionSummary[]>();
  for (const r of regions) {
    if (!r.parentId || !continentIds.has(r.parentId)) continue;
    if (r.isSovereignDependency) groupInto(territoriesByContinent, r.parentId, r);
    else groupInto(countriesByContinent, continentIdForCountry(r) ?? r.parentId, r);
    if (r.sovereigntyGroup) groupInto(bySovereigntyGroup, r.sovereigntyGroup, r);
  }
  for (const list of countriesByContinent.values()) list.sort(byName);
  for (const list of territoriesByContinent.values()) list.sort(byName);

  const territoriesByCountryId = new Map<string, RegionSummary[]>();
  for (const group of bySovereigntyGroup.values()) {
    const dependencies = group.filter((g) => g.isSovereignDependency).sort(byName);
    if (dependencies.length === 0) continue;
    // Only the sovereign member gets the panel.
    for (const country of group) {
      if (!country.isSovereignDependency) territoriesByCountryId.set(country.id, dependencies);
    }
  }
  return { continents, countriesByContinent, territoriesByContinent, territoriesByCountryId };
}

/** Countries and territories whose name contains the term (at least two characters). */
export function searchCountries(regions: RegionSummary[], continents: RegionSummary[], term: string): RegionSummary[] {
  const needle = term.trim().toLowerCase();
  if (needle.length < 2) return [];
  const continentIds = new Set(continents.map((c) => c.id));
  return regions
    .filter((r) => r.parentId && continentIds.has(r.parentId) && r.name.toLowerCase().includes(needle))
    .slice(0, 8);
}

/** Taxa each region offers a pack for, from the pack catalog (published packs, downloaded or not). */
export function availableTaxaByRegion(
  packs: PackStatusEntry[],
  regions: RegionSummary[],
): Record<string, TaxonClass[]> {
  const byRegionName = new Map<string, Set<TaxonClass>>();
  for (const p of packs) {
    if (p.type !== "region" || !p.region || !p.taxon) continue;
    addToSetIn(byRegionName, p.region, p.taxon);
  }
  const byRegionId: Record<string, TaxonClass[]> = {};
  for (const r of regions) {
    const taxa = byRegionName.get(r.name);
    if (taxa) byRegionId[r.id] = [...taxa];
  }
  return byRegionId;
}

/** A downloaded country, its ancestors up to World, and every descendant bundled in its pack. */
export function regionsReachableFrom(regions: RegionSummary[], countryNames: Set<string>): Set<string> {
  const byId = new Map(regions.map((r) => [r.id, r]));
  const childrenOf = new Map<string, RegionSummary[]>();
  for (const r of regions) if (r.parentId != null) groupInto(childrenOf, r.parentId, r);
  const available = new Set<string>();
  for (const region of regions) {
    if (!countryNames.has(region.name)) continue;
    available.add(region.id);
    let cursor: RegionSummary | undefined = region;
    while (cursor?.parentId) {
      available.add(cursor.parentId);
      cursor = byId.get(cursor.parentId);
    }
    const stack = [...(childrenOf.get(region.id) ?? [])];
    while (stack.length) {
      const child = stack.pop()!;
      available.add(child.id);
      stack.push(...(childrenOf.get(child.id) ?? []));
    }
  }
  return available;
}

/** The region a region's packs are named after: the nearest one up the tree whose parent is a hub
 *  (World or a continent), mirroring the server's resolvePackRegionName. Packs are built per
 *  country, so a province, or a regional group and its provinces, resolve to the country. A
 *  province shown under its continent has its own packs. */
export function countryAncestorOf(regionById: Map<string, RegionSummary>, id: string): RegionSummary | null {
  let region = regionById.get(id);
  while (region?.parentId) {
    const parent = regionById.get(region.parentId);
    if (!parent?.hasScopedChecklist) break;
    region = parent;
  }
  return region ?? null;
}
