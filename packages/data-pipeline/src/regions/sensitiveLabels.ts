// eBird's regionally sensitive species name their regions as free text ("Ontario-CA"). A label for
// a country that matches none of its provinces never blurs anything, so the species' points there
// would ship precise; this finds those labels so they get fixed.
import { EBIRD_SENSITIVE_SPECIES, sensitiveRegionMatches } from "@lifer/core/species/sensitiveSpecies.js";

/** Subnational labels for this country that match none of its provinces, each once, sorted. */
export function unmatchedSensitiveLabels(
  provinces: Array<{ name: string; groupName?: string | null }>,
  countryName: string,
  iso2: string,
  list = EBIRD_SENSITIVE_SPECIES,
): string[] {
  const unmatched = new Set<string>();
  for (const scope of list.values()) {
    if (scope.global) continue;
    for (const { region } of scope.regions) {
      if (!region.endsWith(`-${iso2}`)) continue;
      if (!provinces.some((p) => sensitiveRegionMatches(region, p.name, countryName, iso2, p.groupName)))
        unmatched.add(region);
    }
  }
  return [...unmatched].sort();
}
