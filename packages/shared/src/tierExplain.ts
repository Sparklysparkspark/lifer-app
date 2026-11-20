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
