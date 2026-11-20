import type { RegionSummary } from "@lifer/shared";
import { matchScore } from "./searchNormalize";
import { countryAncestorOf } from "./regionGrouping";

/** "Manitoba, Canada": a region below country level named with its country, so the US state
 *  Georgia reads apart from the country. */
export function regionLabel(byId: Map<string, RegionSummary>, region: RegionSummary): string {
  const country = countryAncestorOf(byId, region.id);
  return country && country.id !== region.id ? `${region.name}, ${country.name}` : region.name;
}

/** The region named in the search box's "e.g." example: the first one the caller is working in
 *  (the photo's, the page's), or none for a plain placeholder. */
export function searchExampleRegion(
  byId: Map<string, RegionSummary>,
  contextIds: ReadonlyArray<string | null | undefined>,
): RegionSummary | null {
  const context = contextIds.map((id) => (id ? byId.get(id) : undefined)).find((r) => r?.hasScopedChecklist);
  // A country's example is its most populous province, once the catalog names one.
  return (context?.populousChildId ? byId.get(context.populousChildId) : undefined) ?? context ?? null;
}

/** What a region below country level, or a territory, is part of: "Scotland" is part of the
 *  United Kingdom, Puerto Rico of the United States. Null for a country, continent or World. */
export function regionPartOf(byId: Map<string, RegionSummary>, region: RegionSummary): string | null {
  if (region.isSovereignDependency && region.sovereigntyGroup) {
    for (const r of byId.values())
      if (!r.isSovereignDependency && r.sovereigntyGroup === region.sovereigntyGroup) return r.name;
  }
  const country = countryAncestorOf(byId, region.id);
  return country && country.id !== region.id ? country.name : null;
}

/** The territories and realms that belong to a sovereign country, for its drill-in list. */
export function realmsOf(regions: readonly RegionSummary[], country: RegionSummary | undefined): RegionSummary[] {
  if (!country?.sovereigntyGroup || country.isSovereignDependency) return [];
  return regions.filter(
    (r) => r.isSovereignDependency && r.sovereigntyGroup === country.sovereigntyGroup && r.id !== country.id,
  );
}

function depth(byId: Map<string, RegionSummary>, region: RegionSummary): number {
  let d = 0;
  for (let r = region; r.parentId && byId.has(r.parentId); r = byId.get(r.parentId)!) d++;
  return d;
}

/** Regions whose name or alias ("Holland", "Burma") matches, accents ignored: exact and prefix matches first, then the higher
 *  level (countries before provinces), then by name. `available` null means every region. */
export function searchRegions(
  regions: readonly RegionSummary[],
  byId: Map<string, RegionSummary>,
  term: string,
  available: ReadonlySet<string> | null,
  limit = 8,
): RegionSummary[] {
  const scored: Array<{ region: RegionSummary; score: number; depth: number }> = [];
  for (const region of regions) {
    if (available && !available.has(region.id)) continue;
    const score = Math.max(matchScore(region.name, term), ...(region.aliases ?? []).map((a) => matchScore(a, term)));
    if (score > 0) scored.push({ region, score, depth: depth(byId, region) });
  }
  scored.sort((a, b) => b.score - a.score || a.depth - b.depth || a.region.name.localeCompare(b.region.name));
  return scored.slice(0, limit).map((s) => s.region);
}

const RECENTS_KEY = "lifer:recentRegions";
const MAX_RECENTS = 3;

export function recentRegionIds(): string[] {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string").slice(0, MAX_RECENTS) : [];
  } catch {
    return [];
  }
}

/** Most recent first. Drilling Canada > Manitoba keeps only Manitoba: a picked region replaces
 *  its ancestors in the list. */
export function rememberRegion(byId: Map<string, RegionSummary>, id: string): void {
  // World and the continents are only steps on the way down.
  if (!byId.get(id)?.hasScopedChecklist) return;
  const ancestors = new Set<string>();
  for (let r = byId.get(id); r?.parentId; r = byId.get(r.parentId)) ancestors.add(r.parentId);
  const next = [id, ...recentRegionIds().filter((r) => r !== id && !ancestors.has(r))].slice(0, MAX_RECENTS);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // Private mode or blocked storage: suggestions just won't include recents.
  }
}
