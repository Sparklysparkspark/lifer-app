// The rarity pills a species shows, as the desktop's SpeciesCard reads them: inside a region the tier
// here and the worldwide one, both even when they match; outside a region the worldwide one alone.
import { TIER_LABEL } from "../labels";

type T = (key: string, opts?: Record<string, unknown>) => string;

export interface Tiers {
  localTier: string | null;
  localTierReason?: string | null;
  worldTier: string | null;
  worldTierReason?: string | null;
}

export interface Pill {
  /** What the pill says: "Rare here", "Common worldwide", or the plain tier outside a region. */
  text: string;
  /** What VoiceOver says, naming the region: "Rare in British Columbia". */
  label: string;
}

// Too few records to rate reads as Unrated; other gaps show nothing.
const THIN_DATA_REASONS = new Set(["thin_data", "no_data", "few_photos"]);

export const scopedTier = (tier: string | null | undefined, reason: string | null | undefined): string | null =>
  tier && TIER_LABEL[tier] ? tier : reason && THIN_DATA_REASONS.has(reason) ? "unrated" : null;

/** The pills for a species; `region` is the chosen region's name, null for Everywhere. */
export function tierPills(t: T, s: Tiers, region: string | null): Pill[] {
  const local = region ? scopedTier(s.localTier, s.localTierReason) : null;
  const world = scopedTier(s.worldTier, s.worldTierReason);
  const name = (tier: string) => t(TIER_LABEL[tier]);
  const out: Pill[] = [];
  if (local)
    out.push({
      text: t("species.tierHere", { tier: name(local) }),
      label: t("species.tierIn", { tier: name(local), region }),
    });
  if (world) {
    const text = region ? t("species.tierWorldwide", { tier: name(world) }) : name(world);
    out.push({ text, label: t("species.tierWorldwide", { tier: name(world) }) });
  }
  return out;
}
