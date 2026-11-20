import type { TierExplain, TierReason, TierStep } from "@lifer/shared";
import i18n from "../i18n";

// Plain-language lines for a tier's popover, from the explanation stored with the tier.
// Numbers go in as strings so ICU doesn't add digit grouping the English never had.

/** Week of the year (1-52) to its short month name, close enough for a season line. */
function weekToMonthName(week: number): string {
  const month = Math.min(11, Math.max(0, Math.floor(((week - 1) / 52) * 12)));
  return new Intl.DateTimeFormat(i18n.resolvedLanguage ?? i18n.language, { month: "short", timeZone: "UTC" }).format(
    Date.UTC(2000, month, 1),
  );
}

/** "Mostly Apr to Sep", or null when the species isn't clearly seasonal. */
export function describeSeason(season: TierExplain["season"]): string | null {
  if (!season) return null;
  const start = weekToMonthName(season.startWeek);
  const end = weekToMonthName(season.endWeek);
  return start === end
    ? i18n.t("tierDetails.why.seasonOneMonth", { month: start })
    : i18n.t("tierDetails.why.season", { start, end });
}

function formatShare(rate: number): string {
  // rate is per 1,000; show it as a percentage people can picture.
  const pct = rate / 10;
  if (pct >= 10) return `${Math.round(pct)}%`;
  if (pct >= 1) return `${pct.toFixed(1).replace(/\.0$/, "")}%`;
  if (pct >= 0.01) return `${pct.toFixed(2).replace(/0$/, "")}%`;
  return i18n.t("tierDetails.why.underShare");
}

function describeStep(step: TierStep): string {
  switch (step.kind) {
    case "concentrated":
      return i18n.t("tierDetails.why.step.concentrated");
    case "short_season":
      return i18n.t("tierDetails.why.step.shortSeason", { weeks: String(step.weeks) });
    case "few_years":
      return i18n.t("tierDetails.why.step.fewYears", { years: String(step.years) });
    case "nocturnal":
      return i18n.t("tierDetails.why.step.nocturnal");
    case "dense_habitat":
      return i18n.t("tierDetails.why.step.denseHabitat");
    case "low_density":
      return i18n.t("tierDetails.why.step.lowDensity");
    case "wide_ranging":
      return i18n.t("tierDetails.why.step.wideRanging");
    case "deep_water":
      return i18n.t("tierDetails.why.step.deepWater", { depth: String(Math.round(step.depthM)) });
    case "threatened":
      return step.iucn === "CR"
        ? i18n.t("tierDetails.why.step.criticallyEndangered")
        : i18n.t("tierDetails.why.step.endangered");
    case "small_range":
      return i18n.t("tierDetails.why.step.smallRange");
  }
}

/** "about 50%", "about 12%", "about 1 in 40" for a share of the most-reported birds. */
function formatRelative(r: number): string {
  if (r >= 0.4) return i18n.t("tierDetails.why.aboutShare", { share: `${Math.round(r * 10) * 10}%` });
  if (r >= 0.1) return i18n.t("tierDetails.why.aboutShare", { share: `${Math.round(r * 100)}%` });
  return i18n.t("tierDetails.why.aboutOneIn", { denominator: String(Math.round(1 / r)) });
}

/** `place` is the region's name, or null for the worldwide tier. */
export function describeTier(explain: TierExplain | null, reason: TierReason | null, place: string | null): string[] {
  const where = place ? i18n.t("tierDetails.why.whereIn", { place }) : i18n.t("tierDetails.why.whereWorldwide");
  if (reason === "thin_data" || reason === "no_data") return [i18n.t("tierDetails.why.notEnoughRecords", { where })];
  if (reason === "few_photos") return [i18n.t("tierDetails.why.fewPhotos", { where })];
  if (reason === "domestic") return [i18n.t("tierDetails.why.domestic")];
  if (reason === "untiered_group") return [i18n.t("tierDetails.why.untieredGroup")];
  if (!explain) return [];
  const lines: string[] = [];
  if (reason === "vagrant") lines.push(i18n.t("tierDetails.why.vagrant", { where }));
  if (explain.easiestIn) {
    lines.push(
      explain.base
        ? i18n.t("tierDetails.why.easiestInWhere", { place: explain.easiestIn, tier: explain.base })
        : i18n.t("tierDetails.why.easiestIn", { place: explain.easiestIn }),
    );
  } else if (explain.rate === 0 && explain.source === "inat") {
    lines.push(i18n.t("tierDetails.why.noInatPhotos", { where }));
  } else if (explain.relative != null) {
    lines.push(
      explain.relative >= 0.95
        ? i18n.t("tierDetails.why.mostReported", { where })
        : i18n.t("tierDetails.why.reportedRelative", { share: formatRelative(explain.relative), where }),
    );
  } else if (explain.rate != null) {
    const values = { share: formatShare(explain.rate), group: explain.group, where };
    lines.push(
      explain.source === "inat"
        ? i18n.t("tierDetails.why.inatShare", values)
        : i18n.t("tierDetails.why.sightingsShare", values),
    );
  }
  if (reason === "inherited") lines.push(i18n.t("tierDetails.why.inherited"));
  if (explain.guard) lines.push(i18n.t("tierDetails.why.guard"));
  else for (const step of explain.steps) lines.push(describeStep(step));
  const season = describeSeason(explain.season);
  if (season) lines.push(i18n.t("tierDetails.why.seasonLine", { season }));
  return lines;
}
