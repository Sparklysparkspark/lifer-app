// A smart album's rules are the Gallery's own query params, so saving and editing one goes
// through the same filter state the Gallery uses.
import {
  MULTI_VALUE_FILTERS,
  SHOT_ACTIONS,
  SHOT_FRAMINGS,
  parseShotList,
  taxonDisplayLabel,
  type LifeStage,
  type Sex,
} from "@lifer/shared";
import type { ApiResponse } from "../../api/client";
import i18n from "../../i18n";
import { useRegions } from "../../hooks/useRegions";
import { useSettings } from "../../hooks/useSettings";
import { tierLabel } from "../../lib/speciesGroups";
import { SEX_KEYS, STAGE_KEYS } from "../../lib/appearance";
import { formatList } from "../../lib/format";
import {
  SHOT_ACTION_LABELS,
  SHOT_FRAMING_LABELS,
  UNCATEGORIZED_REGION_ID,
  animalsLabel,
  galleryParams,
  ratingLabel,
  summarizeValues,
  shotTypeForKind,
  shotTypeValues,
} from "./galleryHelpers";
import type { GalleryQuery } from "./types";

export type SmartAlbumRules = NonNullable<ApiResponse<"/albums/{id}">["rules"]>;
type RuleQuery = SmartAlbumRules["query"];

/** A rule set's query as the Gallery API's query string: a list repeats its key. */
export function rulesQueryParams(query: SmartAlbumRules["query"]): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    for (const v of Array.isArray(value) ? value : [value]) if (v !== undefined) params.append(key, String(v));
  return params;
}

export function rulesFromQuery(q: Omit<GalleryQuery, "sortBy">): SmartAlbumRules {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of galleryParams(q)) {
    if ((MULTI_VALUE_FILTERS as readonly string[]).includes(key)) {
      const list = query[key];
      if (Array.isArray(list)) list.push(value);
      else query[key] = [value];
    } else query[key] = value;
  }
  return { version: 2, query: query as RuleQuery };
}

/** The Gallery filter state a rule set stands for: rulesFromQuery the other way round. Rules
 *  saved with the older single shotKind read as the axis it stands for. */
export function queryFromRules({ query: r }: SmartAlbumRules): Omit<GalleryQuery, "sortBy"> {
  const legacy = shotTypeForKind(r.shotKind);
  return {
    searchQuery: r.q ?? "",
    onlyHidden: r.hidden === "1",
    // onlyTopRated is the older spelling of a 5-star minimum.
    ratingMin: r.onlyTopRated === "1" ? 5 : r.ratingMin ? Number(r.ratingMin) : null,
    ratingMax: r.ratingMax ? Number(r.ratingMax) : null,
    unrated: r.unrated === "1",
    animalsMin: r.animalsMin ? Number(r.animalsMin) : null,
    animalsMax: r.animalsMax ? Number(r.animalsMax) : null,
    onlyFeatured: r.onlyFeatured === "1",
    notOnInat: r.notOnInat === "1",
    missingDate: r.missingDate === "1",
    missingCoordinates: r.missingCoordinates === "1",
    shotActions: new Set([...parseShotList(r.action, SHOT_ACTIONS), ...legacy.actions]),
    shotFramings: new Set([...parseShotList(r.framing, SHOT_FRAMINGS), ...legacy.framings]),
    tiers: r.tier ?? [],
    tierRegionId: r.tierRegionId ?? null,
    selectedTaxa: new Set(r.taxa?.split(",").filter(Boolean) ?? []),
    rawFiles: r.onlyRaw === "1" ? "only" : r.includeRaw === "0" ? "hide" : "show",
    editedRaw: r.onlyHasRaw === "1" ? "with" : r.excludeHasRaw === "1" ? "without" : "any",
    mediaFilter:
      r.onlyVideo === "1" ? "videos" : r.onlyAudio === "1" ? "recordings" : r.excludeVideo === "1" ? "photos" : "both",
    dateFrom: r.dateFrom ?? "",
    dateTo: r.dateTo ?? "",
    regionIds: r.regionId ?? [],
    tags: r.tag ?? [],
    places: r.place ?? [],
    appearance: { lifeStage: r.lifeStage ?? [], sex: r.sex ?? [], plumage: r.plumage ?? [], morph: r.morph ?? [] },
    bbox: r.bbox ?? null,
    scopeTripId: r.tripId?.[0] ?? null,
    scopeAlbumId: r.albumId?.[0] ?? null,
  };
}

/** One line naming what the rules match, e.g. "Birds · Flight · 5 stars". The Gallery's default
 *  presets (photos only, no RAW-only files) are left out. */
export function rulesSummary(
  rules: SmartAlbumRules,
  { regionNames, namingStyles }: { regionNames: string[]; namingStyles: string[] },
): string {
  const q = queryFromRules(rules);
  const t = i18n.t.bind(i18n);
  const parts = [
    q.searchQuery && t("albums.smart.summary.search", { q: q.searchQuery }),
    [...q.selectedTaxa].map((tc) => taxonDisplayLabel(tc, namingStyles)).join(", "),
    // Choices within an axis are alternatives: "Flying or Behaviour".
    formatList(
      shotTypeValues(q.shotActions, SHOT_ACTIONS).map((a) => t(SHOT_ACTION_LABELS[a])),
      "disjunction",
    ),
    formatList(
      shotTypeValues(q.shotFramings, SHOT_FRAMINGS).map((f) => t(SHOT_FRAMING_LABELS[f])),
      "disjunction",
    ),
    ratingLabel(q),
    animalsLabel(q),
    q.onlyFeatured && t("gallery.toolbar.featured"),
    q.notOnInat && t("gallery.toolbar.notOnInat"),
    formatList(q.tiers.map(tierLabel), "disjunction"),
    // "BC + Alberta", or "BC + 3 more" past two.
    summarizeValues([
      ...(q.regionIds.includes(UNCATEGORIZED_REGION_ID) ? [t("gallery.toolbar.noRegion")] : []),
      ...regionNames,
    ]),
    summarizeValues(q.places),
    // "Juvenile or Adult · Male"; plumage and morph as typed.
    formatList(
      q.appearance.lifeStage.map((v) => t(STAGE_KEYS[v as LifeStage])),
      "disjunction",
    ),
    formatList(
      q.appearance.sex.map((v) => t(SEX_KEYS[v as Sex])),
      "disjunction",
    ),
    summarizeValues(q.appearance.plumage),
    summarizeValues(q.appearance.morph),
    q.tags.length > 0 && t("albums.smart.summary.tag", { tag: summarizeValues(q.tags) }),
    q.dateFrom && q.dateTo
      ? t("albums.smart.summary.dateRange", { from: q.dateFrom, to: q.dateTo })
      : q.dateFrom
        ? t("albums.smart.summary.dateFrom", { date: q.dateFrom })
        : q.dateTo && t("albums.smart.summary.dateTo", { date: q.dateTo }),
    q.missingDate && t("gallery.toolbar.missingDate"),
    q.missingCoordinates && t("gallery.toolbar.missingCoordinates"),
    q.mediaFilter === "videos" && t("albums.smart.summary.videos"),
    q.mediaFilter === "both" && t("albums.smart.summary.photosAndVideos"),
    q.rawFiles === "only" && t("albums.smart.summary.rawOnly"),
    q.rawFiles === "hide" && t("albums.smart.summary.rawHidden"),
    q.editedRaw === "with" && t("albums.smart.summary.withRaw"),
    q.editedRaw === "without" && t("albums.smart.summary.withoutRaw"),
    q.onlyHidden && t("gallery.toolbar.hidden"),
    q.scopeTripId && t("albums.smart.summary.inTrip"),
    q.scopeAlbumId && t("albums.smart.summary.inAlbum"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  return parts.length > 0 ? parts.join(" · ") : t("albums.smart.summary.all");
}

/** rulesSummary with the region's name and the user's naming styles looked up. */
export function useRulesSummary(rules: SmartAlbumRules | null | undefined): string | null {
  const { regions } = useRegions();
  const { settings } = useSettings();
  if (!rules) return null;
  const regionNames = (rules.query.regionId ?? []).flatMap((id) => regions?.find((r) => r.id === id)?.name ?? []);
  return rulesSummary(rules, { regionNames, namingStyles: settings?.speciesNamingStyles ?? [] });
}
