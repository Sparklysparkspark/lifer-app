// How an IUCN Red List status shows on a species: the badge beside the tier and the stats box.
// Codes and names come from packages/shared/src/iucn.ts; this only decides wording and tone.
import { normalizeIucnStatus, type IucnCode } from "@lifer/shared";
import i18n from "../i18n";

/** threatened: VU and worse; near: NT and LR/cd; neutral: LC and DD; unassessed: NE. */
export type IucnTone = "threatened" | "near" | "neutral" | "unassessed";

export interface IucnBadge {
  code: IucnCode;
  label: string;
  tone: IucnTone;
  /** Hover text: what the status means here, plus the stored caveat when there is one. */
  title: string;
}

const THREATENED: ReadonlySet<IucnCode> = new Set(["EX", "EW", "CR", "EN", "VU"]);
const NEAR: ReadonlySet<IucnCode> = new Set(["NT", "LR/cd"]);

// Each category's name as a translation key (the English matches IUCN_NAMES in @lifer/shared).
const CATEGORY_KEYS: Record<IucnCode, string> = {
  EX: "iucn.category.extinct",
  EW: "iucn.category.extinctInTheWild",
  CR: "iucn.category.criticallyEndangered",
  EN: "iucn.category.endangered",
  VU: "iucn.category.vulnerable",
  "LR/cd": "iucn.category.lowerRiskConservationDependent",
  NT: "iucn.category.nearThreatened",
  LC: "iucn.category.leastConcern",
  DD: "iucn.category.dataDeficient",
  NE: "iucn.category.notEvaluated",
};

/** The category's name in the active language. */
export function iucnCategoryName(code: IucnCode): string {
  return i18n.t(CATEGORY_KEYS[code]);
}

export function iucnTone(code: IucnCode): IucnTone {
  if (code === "NE") return "unassessed";
  if (THREATENED.has(code)) return "threatened";
  if (NEAR.has(code)) return "near";
  return "neutral";
}

/** The badge for a stored status, or null when there's nothing to show (no status at all: the
 *  lookup hasn't run or couldn't decide, and saying nothing is the honest answer then). */
export function iucnBadge(status: string | null | undefined, note?: string | null): IucnBadge | null {
  const code = normalizeIucnStatus(status);
  if (!code) return null;
  const notEvaluated = code === "NE";
  const base = notEvaluated ? i18n.t("iucn.badge.notEvaluatedTitle") : i18n.t("iucn.badge.assessedTitle");
  return {
    code,
    label: notEvaluated
      ? i18n.t("iucn.badge.notEvaluated")
      : i18n.t("iucn.badge.label", { category: iucnCategoryName(code) }),
    tone: iucnTone(code),
    title: note ? `${base}\n${note}` : base,
  };
}

/** The stats box value: the category's name, "Not evaluated" for NE, null for nothing. */
export function iucnStatValue(status: string | null | undefined): string | null {
  const code = normalizeIucnStatus(status);
  if (!code) return null;
  return code === "NE" ? i18n.t("iucn.stat.notEvaluated") : iucnCategoryName(code);
}
