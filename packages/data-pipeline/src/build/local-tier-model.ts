// Absolute rarity tiers: how much field time it takes to find and photograph a species in one
// place. Never a rank against the other species on the list and never a quota per tier: a
// province full of easy birds gets a list full of common birds. Popularity doesn't count.
//
// The ladder, every step of which is recorded in the tier's explanation:
// 1. rate: how often the species turns up relative to its group there (birds, mammals, herps,
//    fish). Birds use GBIF records (nearly all eBird checklists). Mammals, herps and fish use
//    research-grade iNaturalist photos, since their GBIF records are dominated by surveys and
//    specimens, falling back to GBIF where a place has too few photos.
// 2. base tier from fixed bands on that rate.
// 3. step-ups, one tier each: a small part of the area, part of the year, or only some years
//    (from GBIF records), plus traits (at most two) for tiers rated on records.
// 4. a guard: a species recorded far more often than the common threshold stays common.
// The bands are tuned against named anchor species (packages/data-pipeline/data/reference/checklist-anchors.json),
// never against a target share of each tier.
import { NO_RARITY_TIER_TAXON_CLASSES, TIER_ORDER, type TierExplain, type TierGroup, type TierReason, type TierStep, type TierValue } from "@lifer/shared";

/** Group a catalog taxon_class belongs to for tiers, or null for groups that aren't tiered. */
export function tierGroupForTaxonClass(taxonClass: string | null): TierGroup | null {
  switch (taxonClass) {
    case "aves":
      return "birds";
    case "mammalia":
      return "mammals";
    case "amphibia":
    case "squamata":
    case "testudines":
      return "herps";
    // Marine mammals are filed under the Fish group and are found on the same boat and dive
    // trips, so they're measured against the same observer effort.
    case "actinopterygii":
    case "elasmobranchii":
    case "aquatic_mammalia":
      return "fish";
    default:
      return null;
  }
}

// GBIF's raw class names in the country downloads, for the catalog-independent effort count.
const FISH_GBIF_CLASSES = new Set([
  "Actinopterygii",
  "Teleostei",
  "Chondrostei",
  "Cladistii",
  "Holostei",
  "Elasmobranchii",
  "Holocephali",
  "Myxini",
  "Petromyzonti",
  "Coelacanthi",
  "Dipneusti",
]);
const HERP_GBIF_CLASSES = new Set(["Amphibia", "Reptilia", "Squamata", "Testudines", "Crocodylia", "Sphenodontia"]);

/** Effort group of a GBIF record by its raw class (and order, to move marine mammals to fish). */
export function tierGroupForGbifClass(gbifClass: string, gbifOrder?: string | null): TierGroup | null {
  if (gbifClass === "Aves") return "birds";
  if (gbifClass === "Mammalia") return gbifOrder && MARINE_MAMMAL_ORDERS.has(gbifOrder) ? "fish" : "mammals";
  if (HERP_GBIF_CLASSES.has(gbifClass)) return "herps";
  if (FISH_GBIF_CLASSES.has(gbifClass)) return "fish";
  return null;
}
const MARINE_MAMMAL_ORDERS = new Set(["Cetacea", "Sirenia"]);

/** Records per 1,000 group records at each tier's lower edge: common, occasional, uncommon, rare.
 *  Below the rare edge is legendary. */
export const TIER_RATE_BANDS: Record<TierGroup, readonly [number, number, number, number]> = {
  birds: [2, 0.5, 0.1, 0.015],
  mammals: [10, 3, 0.8, 0.2],
  herps: [8, 2, 0.5, 0.1],
  fish: [8, 2, 0.5, 0.1],
};

/** Birds are rated on eBird records as a share of the place's most-reported birds (the top five's
 *  average), so a species-rich place doesn't dilute every bird. Tiers follow SuperPicky's:
 *  Common is an everyday bird; Occasional turns up in the right habitat; Uncommon needs a
 *  dedicated search; Rare needs travel and patience; Legendary is once in a lifetime.
 *  Lower edges of common, occasional, uncommon and rare; below the last is legendary. */
export const RELATIVE_BANDS = [0.5, 0.08, 0.02, 0.003] as const;
/** At this share of the most-recorded species it stays Common whatever else applies. */
export const RELATIVE_GUARD = 0.8;
/** Mammals, reptiles, amphibians and fish are rated the same way on iNaturalist photos, with one
 *  correction: people photograph nearly every sought-after animal they meet but hardly any
 *  everyday ones, so photos overstate how easy a sought-after species is. The share is
 *  discounted by the species' interest (Wikipedia views) relative to the place's
 *  most-photographed ones, to this power. Fitted on anchor species. */
export const PHOTO_INTEREST_POWER = 1.25;
/** Views floor for the correction, so an article nobody reads doesn't blow it up. */
const INTEREST_FLOOR_FOR_CORRECTION = 1000;

/** Below this many recent live records of a group in a place, its rates mean little. */
export const THIN_EFFORT_RECORDS = 2000;
/** Research-grade photos of a group in a place needed to rate on photos instead of records. */
export const INAT_THIN_EFFORT = 1000;
/** Groups rated on GBIF records first (eBird checklists for birds), the rest on photos first. */
const RECORDS_FIRST_GROUPS = new Set<TierGroup>(["birds"]);
/** English Wikipedia views a year below which a species is too little sought after for its photo
 *  count to show how often it's found. Few photos of one says nothing, so it isn't rated from
 *  them; plenty of photos still does. */
export const INTEREST_FLOOR_PAGEVIEWS = 20_000;
/** Core range under this share of the area's diagonal counts as concentrated. */
export const CONCENTRATED_RANGE_RATIO = 0.15;
/** Below this many records, spatial and yearly spread reflect sampling more than the species,
 *  so those steps would count its rarity twice. */
export const MIN_RECORDS_FOR_PATTERN = 50;
/** Fewer weeks than this holding its records counts as a short season. */
export const SHORT_SEASON_WEEKS = 12;
/** Recorded in this many of the last 15 years or fewer counts as irregular. */
export const FEW_YEARS = 4;
/** A species flagged vagrant but recorded this often over this many years is established. */
export const ESTABLISHED_RECORDS = 100;
export const ESTABLISHED_YEARS = 5;
/** A rate this many times the common edge stays common whatever else applies. */
export const STRONG_EVIDENCE_MULTIPLE = 3;

const KM_PER_DEGREE = 111;

export interface HotspotCluster {
  centroidLat: number;
  centroidLon: number;
  pointCount: number;
  bboxDiagonalKm: number;
}

/** How far across a species' core range reaches, ignoring clusters that are both small (at most
 *  10% of its records) and far out (2.5 standard deviations), so strays don't make a local
 *  species look widespread. Same rule the province build uses. */
export function coreRangeDiagonalKm(clusters: readonly HotspotCluster[]): number {
  if (clusters.length === 0) return 0;
  if (clusters.length === 1) return clusters[0].bboxDiagonalKm;
  const total = clusters.reduce((sum, cl) => sum + cl.pointCount, 0);
  const centroidLat = clusters.reduce((sum, cl) => sum + cl.centroidLat * cl.pointCount, 0) / total;
  const centroidLon = clusters.reduce((sum, cl) => sum + cl.centroidLon * cl.pointCount, 0) / total;
  const lonScale = Math.cos((centroidLat * Math.PI) / 180);
  const distanceKm = (cl: HotspotCluster) =>
    Math.sqrt((cl.centroidLat - centroidLat) ** 2 + ((cl.centroidLon - centroidLon) * lonScale) ** 2) * KM_PER_DEGREE;
  const meanDistanceKm = clusters.reduce((sum, cl) => sum + distanceKm(cl) * cl.pointCount, 0) / total;
  const stdDevKm = Math.sqrt(clusters.reduce((sum, cl) => sum + (distanceKm(cl) - meanDistanceKm) ** 2 * cl.pointCount, 0) / total);
  const core = clusters.filter((cl) => {
    const isSmall = cl.pointCount / total <= 0.1;
    const isFar = stdDevKm > 0 && distanceKm(cl) > meanDistanceKm + 2.5 * stdDevKm;
    return !(isSmall && isFar);
  });
  const effective = core.length > 0 ? core : clusters;
  if (effective.length === 1) return effective[0].bboxDiagonalKm;
  const lats = effective.map((cl) => cl.centroidLat);
  const lons = effective.map((cl) => cl.centroidLon);
  const centroidSpanKm =
    Math.sqrt((Math.max(...lats) - Math.min(...lats)) ** 2 + ((Math.max(...lons) - Math.min(...lons)) * lonScale) ** 2) * KM_PER_DEGREE;
  const maxClusterRadiusKm = Math.max(...effective.map((cl) => cl.bboxDiagonalKm / 2));
  return centroidSpanKm + maxClusterRadiusKm * 2;
}

export interface TierTraits {
  nocturnal?: boolean | null;
  habitatDensity?: number | null;
  densityPerKm2?: number | null;
  homeRangeKm2?: number | null;
  depthMinM?: number | null;
  iucnStatus?: string | null;
  domestic?: boolean | null;
  rangeSizeKm2?: number | null;
}

export interface TierInput {
  taxonClass: string | null;
  /** The species' recent live records in the place (GBIF), or null when there are none. */
  records: number | null;
  /** All recent live records of the species' group in the place. */
  effort: number | null;
  /** Research-grade iNaturalist observations of the species, and of its group, in the place.
   *  Used first when the group has at least INAT_THIN_EFFORT; 0 records there means nobody has
   *  managed a confirmed photo of it in a well-photographed place. */
  inatRecords?: number | null;
  inatEffort?: number | null;
  /** Average records of the place's five most-reported species in the group: the reference a bird
   *  rated on records is measured against (RELATIVE_BANDS). */
  referenceRecords?: number | null;
  /** The same for photo-rated groups: the average photos of the place's five most-photographed
   *  species in the group, and their typical (geometric mean) Wikipedia views. */
  referencePhotos?: number | null;
  referenceInterest?: number | null;
  /** Core range of its hotspot clusters over the place's diagonal, or null when unknown. */
  concentrationRatio?: number | null;
  recentDistinctYears?: number | null;
  /** 52 weekly record counts. */
  weeklyFrequency?: readonly number[] | null;
  isVagrant?: boolean | null;
  traits?: TierTraits;
  /** English Wikipedia pageviews over the last year; null when the species has no article. */
  interest?: number | null;
  /** For the worldwide tier: steps that only make sense at that scale. */
  scope?: "local" | "global";
}

export interface TierResult {
  tier: TierValue | null;
  reason: TierReason;
  explain: TierExplain | null;
}

function tierIndex(t: TierValue): number {
  return TIER_ORDER.indexOf(t);
}

/** A photo-rated species' share of the place's most-photographed ones, discounted for interest.
 *  Only ever discounted, and one photographed as often as the top five is Common however
 *  famous it is. */
function photoRelative(photos: number, referencePhotos: number, referenceInterest: number, interest: number): number {
  const raw = photos / referencePhotos;
  if (raw >= 1) return raw;
  const discount = Math.min(1, Math.pow(referenceInterest / Math.max(INTEREST_FLOOR_FOR_CORRECTION, interest), PHOTO_INTEREST_POWER));
  return raw * discount;
}

function relativeTier(relative: number): TierValue {
  const [common, occasional, uncommon, rare] = RELATIVE_BANDS;
  if (relative >= common) return "common";
  if (relative >= occasional) return "occasional";
  if (relative >= uncommon) return "uncommon";
  if (relative >= rare) return "rare";
  return "legendary";
}

function baseTier(group: TierGroup, rate: number): TierValue {
  const [common, occasional, uncommon, rare] = TIER_RATE_BANDS[group];
  if (rate >= common) return "common";
  if (rate >= occasional) return "occasional";
  if (rate >= uncommon) return "uncommon";
  if (rate >= rare) return "rare";
  return "legendary";
}

/** The weeks holding most of a species' records, when it's clearly seasonal: the shortest run of
 *  consecutive weeks (wrapping at the year's end) holding 80% of them, if under 40 weeks. */
export function seasonWindow(weekly: readonly number[] | null | undefined): { startWeek: number; endWeek: number; weeks: number } | null {
  if (!weekly || weekly.length !== 52) return null;
  const total = weekly.reduce((a, b) => a + b, 0);
  if (total < 20) return null;
  const target = total * 0.8;
  let best: { start: number; len: number } | null = null;
  for (let start = 0; start < 52; start++) {
    let sum = 0;
    for (let len = 1; len <= 52; len++) {
      sum += weekly[(start + len - 1) % 52];
      if (sum >= target) {
        if (!best || len < best.len) best = { start, len };
        break;
      }
    }
  }
  if (!best || best.len >= 40) return null;
  return { startWeek: best.start + 1, endWeek: ((best.start + best.len - 1) % 52) + 1, weeks: best.len };
}

function traitSteps(group: TierGroup, traits: TierTraits): TierStep[] {
  const steps: TierStep[] = [];
  if (traits.nocturnal) steps.push({ kind: "nocturnal" });
  // Dense habitat isn't a step: a sighting rate already reflects how hard a bird is to see.
  // Population density is only reliable enough for mammals.
  if (group === "mammals" && traits.densityPerKm2 != null && traits.densityPerKm2 < 0.05) {
    steps.push({ kind: "low_density", perKm2: traits.densityPerKm2 });
  }
  if (traits.homeRangeKm2 != null && traits.homeRangeKm2 > 500) steps.push({ kind: "wide_ranging", homeRangeKm2: traits.homeRangeKm2 });
  if (group === "fish" && traits.depthMinM != null && traits.depthMinM > 30) steps.push({ kind: "deep_water", depthM: traits.depthMinM });
  return steps;
}

/** How many tiers the trait steps add: at most two, and very deep water counts as two alone. */
function traitWeight(steps: TierStep[]): number {
  let weight = 0;
  for (const s of steps) weight += s.kind === "deep_water" && s.depthM > 60 ? 2 : 1;
  return Math.min(2, weight);
}

export function tierFromInputs(input: TierInput): TierResult {
  const group = tierGroupForTaxonClass(input.taxonClass);
  if (!group) {
    const untiered = input.taxonClass != null && NO_RARITY_TIER_TAXON_CLASSES.has(input.taxonClass as never);
    return { tier: null, reason: untiered ? "untiered_group" : "no_data", explain: null };
  }
  const traits = input.traits ?? {};
  if (traits.domestic) return { tier: null, reason: "domestic", explain: null };

  let rate: number | null = null;
  let records: number | null = null;
  let effort: number | null = null;
  let source: TierExplain["source"] = null;
  const photosUsable = input.inatRecords != null && input.inatEffort != null && input.inatEffort >= INAT_THIN_EFFORT;
  const recordsUsable = input.records != null && input.records > 0 && input.effort != null && input.effort > 0;
  const useRecords = recordsUsable && (RECORDS_FIRST_GROUPS.has(group) ? input.effort! >= THIN_EFFORT_RECORDS || !photosUsable : !photosUsable);
  if (useRecords) {
    records = input.records!;
    effort = input.effort!;
    source = "gbif";
  } else if (photosUsable) {
    records = input.inatRecords!;
    effort = input.inatEffort!;
    source = "inat";
  }
  if (records != null && effort != null) rate = (1000 * records) / effort;
  const relative =
    source === "gbif" && group === "birds" && input.referenceRecords != null && input.referenceRecords > 0
      ? records! / input.referenceRecords
      : source === "inat" && input.referencePhotos != null && input.referencePhotos > 0 && input.referenceInterest != null
        ? photoRelative(records!, input.referencePhotos, input.referenceInterest, input.interest ?? 0)
        : null;

  const season = seasonWindow(input.weeklyFrequency);
  const explainBase = {
    v: 1 as const,
    group,
    rate,
    records,
    effort,
    source,
    ...(relative != null && { relative }),
    season: season ? { startWeek: season.startWeek, endWeek: season.endWeek } : null,
  };

  // A one-off visitor is about as hard a photo as there is. The vagrant flag also marks introduced
  // species, so one with a steady record over years counts as established and is rated normally.
  const established = (input.records ?? 0) >= ESTABLISHED_RECORDS && (input.recentDistinctYears ?? 0) >= ESTABLISHED_YEARS;
  if (input.isVagrant && !established) {
    return { tier: "legendary", reason: "vagrant", explain: { ...explainBase, base: null, steps: [], guard: false } };
  }
  if (rate == null) return { tier: null, reason: "no_data", explain: null };
  if (source === "gbif" && effort! < THIN_EFFORT_RECORDS) return { tier: null, reason: "thin_data", explain: { ...explainBase, base: null, steps: [], guard: false } };

  const base = relative != null ? relativeTier(relative) : baseTier(group, rate);
  const [commonEdge] = TIER_RATE_BANDS[group];
  if (relative != null ? relative >= RELATIVE_GUARD : rate >= STRONG_EVIDENCE_MULTIPLE * commonEdge) {
    return { tier: "common", reason: "rated", explain: { ...explainBase, base, steps: [], guard: true } };
  }

  const steps: TierStep[] = [];
  let bump = 0;
  // The map and year patterns come from GBIF records (iNaturalist counts carry no locations).
  const enoughForPattern = (input.records ?? 0) >= MIN_RECORDS_FOR_PATTERN;
  if (enoughForPattern && input.concentrationRatio != null && input.concentrationRatio < CONCENTRATED_RANGE_RATIO) {
    steps.push({ kind: "concentrated", ratio: Math.round(input.concentrationRatio * 1000) / 1000 });
    bump++;
  }
  if (season && season.weeks < SHORT_SEASON_WEEKS) {
    steps.push({ kind: "short_season", weeks: season.weeks });
    bump++;
  } else if (enoughForPattern && input.recentDistinctYears != null && input.recentDistinctYears <= FEW_YEARS) {
    steps.push({ kind: "few_years", years: input.recentDistinctYears });
    bump++;
  }
  if (input.scope === "global" && traits.rangeSizeKm2 != null && traits.rangeSizeKm2 < 20_000) {
    steps.push({ kind: "small_range", rangeKm2: traits.rangeSizeKm2 });
    bump++;
  }
  // A photo count already reflects what makes a species hard to photograph, so traits only
  // adjust tiers rated on sighting records.
  if (source === "gbif") {
    const traitList = traitSteps(group, traits);
    steps.push(...traitList);
    bump += traitWeight(traitList);
    // Conservation status isn't a step: an endangered species can still be easy to find.
    // It's shown beside the tier instead.
  }
  // Photo-rated mammals get no low-density step: the interest correction already covers it.

  const tier = TIER_ORDER[Math.min(TIER_ORDER.length - 1, tierIndex(base) + bump)];
  const explain = { ...explainBase, base, steps, guard: false };
  // Rated hard on photos with little public interest, a species is as likely overlooked as hard
  // to find, so it shows as not enough data rather than an unearned tier.
  if (source === "inat" && tierIndex(tier) >= tierIndex("uncommon") && (input.interest ?? 0) < INTEREST_FLOOR_PAGEVIEWS) {
    return { tier: null, reason: "few_photos", explain };
  }
  return { tier, reason: "rated", explain };
}
