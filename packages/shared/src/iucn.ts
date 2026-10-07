// IUCN Red List categories: the one place that knows the stored codes, their display names and
// how severe each is. species_traits.iucn_status stores the code (a CHECK constraint, migration
// 129, allows exactly IUCN_CODES); everything that reads or writes it goes through here.

/** Stored codes. "LR/cd" is the 1994 Lower Risk/conservation dependent category, still on a few
 *  old assessments; the other Lower Risk subcategories fold into NT and LC (normalizeIucnStatus). */
export const IUCN_CODES = ["EX", "EW", "CR", "EN", "VU", "LR/cd", "NT", "LC", "DD", "NE"] as const;
export type IucnCode = (typeof IUCN_CODES)[number];

export const IUCN_NAMES: Record<IucnCode, string> = {
  EX: "Extinct",
  EW: "Extinct in the Wild",
  CR: "Critically Endangered",
  EN: "Endangered",
  VU: "Vulnerable",
  "LR/cd": "Lower Risk/conservation dependent",
  NT: "Near Threatened",
  LC: "Least Concern",
  DD: "Data Deficient",
  NE: "Not Evaluated",
};

/** Where a stored status came from (species_traits.iucn_source). */
export type IucnSource = "iucn_red_list" | "wikidata" | "inaturalist";

// Most severe first; IUCN_CODES is already in this order. Data Deficient and Not Evaluated rank
// below Least Concern since they say nothing about threat.
const SEVERITY_RANK = new Map<IucnCode, number>(IUCN_CODES.map((c, i) => [c, IUCN_CODES.length - i]));

/** Higher is more threatened; 0 for no status. */
export function iucnSeverity(code: IucnCode | null | undefined): number {
  return code ? (SEVERITY_RANK.get(code) ?? 0) : 0;
}

/** The most severe of several statuses (e.g. several threatStatuses on one record), or null. */
export function mostSevereIucn(codes: Iterable<IucnCode | null | undefined>): IucnCode | null {
  let best: IucnCode | null = null;
  for (const c of codes) if (c && iucnSeverity(c) > iucnSeverity(best)) best = c;
  return best;
}

/** Threatened in the Red List sense: CR, EN or VU. */
export function isIucnThreatened(code: IucnCode | null | undefined): boolean {
  return code === "CR" || code === "EN" || code === "VU";
}

export function isIucnCode(value: unknown): value is IucnCode {
  return typeof value === "string" && (IUCN_CODES as readonly string[]).includes(value);
}

// Every spelling seen in the wild, keyed after normalizeKey: Wikidata labels ("least concern",
// "Data Deficient"), GBIF enums ("LEAST_CONCERN"), older pipeline values ("extinct_in_wild"),
// iNaturalist names and the IUCN archive's lowercase Lower Risk labels.
const ALIASES: Record<string, IucnCode> = {
  ex: "EX",
  extinct: "EX",
  ew: "EW",
  "extinct in the wild": "EW",
  "extinct in wild": "EW",
  cr: "CR",
  "critically endangered": "CR",
  "cr pe": "CR",
  "cr pew": "CR",
  en: "EN",
  endangered: "EN",
  vu: "VU",
  vulnerable: "VU",
  "lr cd": "LR/cd",
  cd: "LR/cd",
  "conservation dependent": "LR/cd",
  "lower risk conservation dependent": "LR/cd",
  nt: "NT",
  "near threatened": "NT",
  "lr nt": "NT",
  "lower risk near threatened": "NT",
  lc: "LC",
  "least concern": "LC",
  "lr lc": "LC",
  "lower risk least concern": "LC",
  dd: "DD",
  "data deficient": "DD",
  ne: "NE",
  "not evaluated": "NE",
};

function normalizeKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\((possibly extinct|possibly extinct in the wild)\)/g, "") // "Critically Endangered (Possibly Extinct)"
    .replace(/[_/\-().,:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Any known spelling of a Red List category to its code; null for anything else (regional
 *  categories like "Regionally Extinct", "Not Applicable", plain "Lower Risk", junk). Codes pass
 *  through unchanged. */
export function normalizeIucnStatus(raw: string | null | undefined): IucnCode | null {
  if (raw == null) return null;
  if (isIucnCode(raw)) return raw;
  return ALIASES[normalizeKey(raw)] ?? null;
}

/** iNaturalist's normalized numeric `iucn` level on a conservation_statuses entry. */
const INAT_IUCN_LEVELS: Record<number, IucnCode> = {
  0: "NE",
  5: "DD",
  10: "LC",
  20: "NT",
  30: "VU",
  40: "EN",
  50: "CR",
  60: "EW",
  70: "EX",
};

export function iucnCodeFromInatLevel(level: number | null | undefined): IucnCode | null {
  return level == null ? null : (INAT_IUCN_LEVELS[level] ?? null);
}

/** Display name for a stored value; tolerates a legacy spelling, null for nothing usable. */
export function iucnDisplayName(raw: string | null | undefined): string | null {
  const code = normalizeIucnStatus(raw);
  return code ? IUCN_NAMES[code] : null;
}
