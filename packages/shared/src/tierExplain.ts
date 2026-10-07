// Why a species has the rarity tier it has in a region, stored with the tier
// (region_species.tier_explain, species_rarity.tier_explain) and shown when a tier badge is
// tapped. Tiers are absolute: how often the species is actually recorded there relative to how
// much observing happens there, moved by facts about the species itself. Never a rank against
// the other species on the same list.

// SuperPicky's five tiers: Common (everyday, anywhere), Occasional (if you go to the right habitat),
// Uncommon (a dedicated search), Rare (travel and patience), Legendary (once in a lifetime).
export type TierValue = "common" | "occasional" | "uncommon" | "rare" | "legendary";

export const TIER_ORDER: readonly TierValue[] = ["common", "occasional", "uncommon", "rare", "legendary"];

/** Species groups tiers are computed within: each has its own observer effort and bands. */
export type TierGroup = "birds" | "mammals" | "herps" | "fish";

export type TierStep =
  | { kind: "concentrated"; ratio: number }
  | { kind: "short_season"; weeks: number }
  | { kind: "few_years"; years: number }
  | { kind: "nocturnal" }
  | { kind: "dense_habitat" }
  | { kind: "low_density"; perKm2: number }
  | { kind: "wide_ranging"; homeRangeKm2: number }
  | { kind: "deep_water"; depthM: number }
  | { kind: "threatened"; iucn: string }
  | { kind: "small_range"; rangeKm2: number };

/** Why a tier is missing, or what decided it outside the rate ladder. */
export type TierReason =
  "rated" | "thin_data" | "no_data" | "few_photos" | "domestic" | "vagrant" | "untiered_group" | "inherited";

export interface TierExplain {
  v: 1;
  group: TierGroup;
  /** Records of this species per 1,000 records of its group there (recent, live observations). */
  rate: number | null;
  records: number | null;
  effort: number | null;
  /** Where the counts came from: GBIF live observations, or iNaturalist research grade. */
  source: "gbif" | "inat" | null;
  base: TierValue | null;
  steps: TierStep[];
  /** Recorded so often that nothing else could make it hard to find. */
  guard: boolean;
  /** Weeks of the year it's mostly recorded in (1-52), when it's clearly seasonal. */
  season: { startWeek: number; endWeek: number } | null;
  /** Birds: how often it's reported as a share of the place's most-reported birds (1 = as often). */
  relative?: number | null;
  /** Worldwide tier only: the country where the species is easiest to find, whose tier it takes. */
  easiestIn?: string | null;
}

const GROUP_NOUN: Record<TierGroup, string> = {
  birds: "bird",
  mammals: "mammal",
  herps: "reptile and amphibian",
  fish: "fish and marine mammal",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Week of the year (1-52) to its month name, close enough for a season line. */
export function weekToMonthName(week: number): string {
  return MONTHS[Math.min(11, Math.max(0, Math.floor(((week - 1) / 52) * 12)))];
}

/** "Mostly Apr to Sep", or null when the species isn't clearly seasonal. */
export function describeSeason(season: TierExplain["season"]): string | null {
  if (!season) return null;
  const start = weekToMonthName(season.startWeek);
  const end = weekToMonthName(season.endWeek);
  return start === end ? `Mostly in ${start}` : `Mostly ${start} to ${end}`;
}

function formatShare(rate: number): string {
  // rate is per 1,000; show it as a percentage people can picture.
  const pct = rate / 10;
  if (pct >= 10) return `${Math.round(pct)}%`;
  if (pct >= 1) return `${pct.toFixed(1).replace(/\.0$/, "")}%`;
  if (pct >= 0.01) return `${pct.toFixed(2).replace(/0$/, "")}%`;
  return "under 0.01%";
}

function describeStep(step: TierStep): string {
  switch (step.kind) {
    case "concentrated":
      return "Found in only a small part of the area.";
    case "short_season":
      return `Only around for about ${step.weeks} weeks of the year.`;
    case "few_years":
      return `Recorded in only ${step.years} of the last 15 years.`;
    case "nocturnal":
      return "Mostly active at night.";
    case "dense_habitat":
      return "Lives in dense habitat, hard to get a clear view.";
    case "low_density":
      return "Thinly spread even where it lives.";
    case "wide_ranging":
      return "Ranges over a very large area, so encounters are rare.";
    case "deep_water":
      return `Usually deeper than ${Math.round(step.depthM)} m.`;
    case "threatened":
      return step.iucn === "CR" ? "Critically endangered." : "Endangered.";
    case "small_range":
      return "Lives in a very small range worldwide.";
  }
}

/** "about 50%", "about 12%", "about 1 in 40" for a share of the most-reported birds. */
function formatRelative(r: number): string {
  if (r >= 0.4) return `about ${Math.round(r * 10) * 10}%`;
  if (r >= 0.1) return `about ${Math.round(r * 100)}%`;
  return `about 1 in ${Math.round(1 / r)}`;
}

/** Plain-language lines for a tier's popover. `place` is the region's name, or null for the
 *  worldwide tier. */
export function describeTier(explain: TierExplain | null, reason: TierReason | null, place: string | null): string[] {
  const where = place ? ` in ${place}` : " worldwide";
  if (reason === "thin_data" || reason === "no_data") {
    return [`Not enough records${where} yet to say how hard this is to find.`];
  }
  if (reason === "few_photos") {
    return [
      `Few people photograph this species, so its photos${where} can't show whether it's hard to find or just overlooked.`,
    ];
  }
  if (reason === "domestic") return ["Domestic or captive animal, not rated."];
  if (reason === "untiered_group")
    return ["Lifer doesn't rate this group yet: there are too few records to be reliable."];
  if (!explain) return [];
  const lines: string[] = [];
  if (reason === "vagrant") lines.push(`A rare visitor${where}, not a regular resident.`);
  if (explain.easiestIn) {
    lines.push(`Easiest to find in ${explain.easiestIn}${explain.base ? `, where it's ${explain.base}` : ""}.`);
  } else if (explain.rate === 0 && explain.source === "inat") {
    lines.push(`No confirmed photos of it on iNaturalist${where} yet.`);
  } else if (explain.relative != null) {
    lines.push(
      explain.relative >= 0.95
        ? `One of the most-reported birds${where}.`
        : `Reported ${formatRelative(explain.relative)} as often as the most-reported birds${where}.`,
    );
  } else if (explain.rate != null) {
    const noun = GROUP_NOUN[explain.group];
    lines.push(
      explain.source === "inat"
        ? `Makes up ${formatShare(explain.rate)} of confirmed ${noun} photos on iNaturalist${where}.`
        : `Makes up ${formatShare(explain.rate)} of ${noun} sightings${where}.`,
    );
  }
  if (reason === "inherited") lines.push(`Few records here, so this uses the tier for the wider country.`);
  if (explain.guard) lines.push("Recorded so often that it's easy to find anyway.");
  else for (const step of explain.steps) lines.push(describeStep(step));
  const season = describeSeason(explain.season);
  if (season) lines.push(`${season}.`);
  return lines;
}
