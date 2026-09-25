import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  TAXON_CLASS_LABEL,
  otherTaxaGroupLabel,
  type TaxonClass,
  type CollectionItem,
  type RegionSpeciesResponse,
  type RegionSpeciesResult,
  type RegionSummary,
} from "@lifer/shared";
import { api, ApiError } from "../api/client";
import { formatBytes } from "../lib/formatBytes";
import { useAuth } from "../hooks/useAuth";
import AppNav from "../components/AppNav";
import GroupedSpeciesGrid, { type GroupBy, type SortBy } from "../components/GroupedSpeciesGrid";
import { useSpeciesCardSize } from "../hooks/useSpeciesCardSize";
import RegionMap from "../components/RegionMap";
import { useMapAvailable } from "../hooks/useMapAvailable";
import { Spinner } from "../components/LoadingScreen";
import EmptyState from "../components/EmptyState";
import Pill from "../components/Pill";
import FilterPopover, { FilterFieldLabel } from "../components/FilterPopover";
import Select from "../components/Select";
import AddOtherTaxaModal from "../components/AddOtherTaxaModal";
import SearchInput from "../components/SearchInput";

type StateFilter = "all" | "collected" | "seen" | "target" | "unseen";
// "other-taxa" is a real, separate value on the wire (see collection/routes.ts's own comment on
// the sentinel) — species added via Settings > Species & Import's any-taxa search never carry
// one of the fixed TaxonClass values, so they need their own filter bucket rather than folding
// into "all". Widened to plain `string` (not a closed union) because a SPECIFIC Other Taxa
// iconic-taxon group (e.g. "insecta") is also a real, selectable filter value now (see
// otherTaxaIconicFiltersPresent below) — the backend's `s.taxon_class = $2` clause already
// matches it directly, since Other Taxa species store iNat's lowercased iconic taxon name in
// that exact column (see organizedPath.ts's own comment on this same reuse).
type TaxonFilter = string;

// Species detail is a SIBLING route (see App.tsx), not nested under this page, so navigating
// there and back fully unmounts/remounts CollectionPage — every `useState` resets to its
// initial value and the load effect below re-fetches from zero, which is what actually caused
// the brief loading flash on "back to collection" (nothing to do with the map: this page
// doesn't even render one). Module-scoped (survives remounts, cleared only on a real reload)
// so the previous view can render INSTANTLY from cache on mount while the effect still
// fetches fresh data in the background and silently updates it if anything changed —
// stale-while-revalidate, without pulling in a whole data-fetching library for one page.
interface CollectionCacheEntry {
  items: CollectionItem[];
  regionMeta: RegionSpeciesResult["region"] | null;
  regionStats: RegionSpeciesResult["stats"] | null;
}
const collectionCache = new Map<string, CollectionCacheEntry>();
function storedLastRegionId(): string | null {
  try {
    return localStorage.getItem("lifer:lastRegionId");
  } catch {
    return null;
  }
}
function collectionCacheKey(
  regionId: string | null,
  taxonFilters: Set<string>,
  seaZoneIds: string[],
  includeLand: boolean,
): string {
  return JSON.stringify([regionId, [...taxonFilters].sort(), [...seaZoneIds].sort(), includeLand]);
}

// All 18 taxon groups (same source GalleryPage/OfflinePacksPage already use) — not just the
// three (birds/mammals/fish) that had checklist data first. A taxon with no region_species
// computed for it yet just shows an empty grid, same as any other region with nothing behind
// it, rather than being hidden from the picker.
const TAXON_LABEL: Record<string, string> = {
  all: "All taxa",
  ...TAXON_CLASS_LABEL,
  "other-taxa": "Other Taxa",
};

// Label for a specific Other Taxa iconic-taxon filter value (e.g. "insecta") — these aren't in
// TAXON_LABEL above since they're discovered dynamically per region (see
// otherTaxaIconicFiltersPresent), not a fixed set. iNat's own iconic taxon names are just the
// lowercased column value capitalized back (confirmed true for all 13 — "Insecta", "Mollusca",
// etc. are single already-capitalized words) — otherTaxaGroupLabel needs that real casing both
// to look up its English label and, when Latin is preferred, as the literal Latin text itself.
function taxonFilterLabel(t: string, namingStyles: string[]): string {
  if (t in TAXON_LABEL) return TAXON_LABEL[t];
  return otherTaxaGroupLabel(t.charAt(0).toUpperCase() + t.slice(1), namingStyles);
}

// Region drill-down lives on the main screen — no region selected means "everything
// collected, worldwide"; picking one (via the breadcrumb below) narrows the same grid to
// that region's checklist without ever leaving this page. `?region=` is a real URL param so
// a drilled-in view is bookmarkable/shareable, same idea as SpeciesDetailPage's `?regionId=`.
export default function CollectionPage() {
  const { user } = useAuth();
  // Every filter/sort/group preference lives in the URL, not plain useState, so sorting and
  // grouping choices never get lost just from navigating between regions, and a specific
  // filtered/grouped view stays shareable and bookmarkable, same as `region` already was.
  const [searchParams, setSearchParams] = useSearchParams();
  const regionId = searchParams.get("region");

  // Restores the last-viewed region from localStorage once on mount, so opening Lifer fresh
  // (no ?region= in the URL) doesn't default to loading the full worldwide checklist. Never
  // overrides a URL that's already there, and never fights a user who clears the region after.
  // A genuinely first-ever login has nothing to restore — firstRunPrompt covers that gap by
  // skipping the worldwide fetch and showing a "browse by region to get started" prompt instead.
  // regionResolved gates the fetch effect below until this effect has run once, so the very
  // first render (before the restore/prompt decision lands) doesn't fire the worldwide fetch.
  const restoredLastRegion = useRef(false);
  const [firstRunPrompt, setFirstRunPrompt] = useState(false);
  // A genuinely first-ever login (no lastRegionId to restore) can't decide between "show the
  // picker" and "jump straight into the one region you've got" until we actually know how many
  // packs are downloaded — that arrives via a separate async fetch, so the decision is deferred
  // to the effect below rather than made here.
  const [pendingFirstRunDecision, setPendingFirstRunDecision] = useState(false);
  const [regionResolved, setRegionResolved] = useState(false);
  useEffect(() => {
    if (restoredLastRegion.current) return;
    restoredLastRegion.current = true;
    if (searchParams.get("region")) {
      setRegionResolved(true);
      return;
    }
    try {
      const lastRegionId = localStorage.getItem("lifer:lastRegionId");
      if (lastRegionId) {
        updateParam("region", lastRegionId);
        setRegionResolved(true);
        return;
      }
    } catch {
      // localStorage can throw in some contexts (private browsing, disabled storage) — a
      // missed restore just falls back to the deferred first-run decision below, not an error.
    }
    setPendingFirstRunDecision(true);
    setRegionResolved(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!regionId) return;
    try {
      localStorage.setItem("lifer:lastRegionId", regionId);
    } catch {
      // Same as above — losing this preference silently is fine, nothing depends on it.
    }
  }, [regionId]);
  const sortBy = (searchParams.get("sort") as SortBy) || "taxonomic";
  const groupBy = (searchParams.get("group") as GroupBy) || "none";
  // Re-grouping/re-sorting a large checklist (GroupedSpeciesGrid's own re-bucketing plus, for
  // family grouping especially, WebKit's multi-column layout cost across dozens of sections —
  // see that component's own comment) is a real, synchronous chunk of work — enough to freeze
  // the page for close to a second with nothing on screen acknowledging the click happened.
  // Wrapping the param update in a transition doesn't make that work any faster, but it lets
  // React keep the OLD grid painted and interactive while the new one computes in the
  // background, with isPending driving a small "Updating…" indicator instead of a hard freeze.
  const [isGroupingPending, startGroupingTransition] = useTransition();
  // "Collected first" and "Seen first" (everything shown, collected/seen pinned at top) are
  // independent toggles — either can be on alone, or both (collected always pins above seen
  // when both are on; see GroupedSpeciesGrid's floatRank). Distinct from the "Show: Collected
  // only" filter (which defaults to "All" below). No param at all means checked for
  // collectedFirst (on by default) and unchecked for seenFirst (off by default) — explicitly
  // toggling either writes its own `=0`/`=1` into the URL so it's distinguishable from the
  // default.
  const collectedFirst = searchParams.get("collectedFirst") !== "0";
  const seenFirst = searchParams.get("seenFirst") === "1";
  const targetFirst = searchParams.get("targetFirst") === "1";
  const stateFilter = (searchParams.get("show") as StateFilter) || "all";
  const ghostOnly = searchParams.get("ghostOnly") === "1";
  const lostOnly = searchParams.get("lostOnly") === "1";
  // Only meaningful with a region selected — seasonality is region-scoped, same gate the
  // "Most likely this month" sort option already uses.
  const likelyThisMonthOnly = searchParams.get("likelyThisMonth") === "1";
  // "Big year" style filter — a specific calendar year the species must have a real capture
  // in, not just user_species.first_collected (see CollectionItem.capturedYears' own comment).
  // Empty string means "all years" (no filter), same convention as taxonFilters' empty set.
  const yearFilter = searchParams.get("year") || "";
  // Checkbox multi-select (e.g. Birds + Mammals at once) — comma-separated in the URL, same
  // convention as seaZones below. Empty set means "all taxa" (no filter), same meaning "all"
  // used to have as the single-select's default value.
  const taxonFilters = useMemo(() => {
    const raw = searchParams.get("taxon");
    return new Set(raw ? raw.split(",").filter(Boolean) : []);
  }, [searchParams]);
  // The single-taxon views below (pack-missing prompt, sea-zone relevance) only make sense
  // pointed at exactly one taxon — undefined for "all" (nothing selected) or a mixed multi-select.
  const singleTaxonFilter = taxonFilters.size === 1 ? [...taxonFilters][0] : undefined;
  // Lets a region's checklist optionally include species from nearby marine zones. Multiple
  // zones can be checked at once (e.g. Red Sea AND Gulf of Aqaba) — each backed by a real
  // marine polygon's species list, not a country-adjacency guess. Comma-separated in the
  // URL, same param-persistence convention as every other filter here.
  const seaZoneIds = useMemo(
    () => (searchParams.get("seaZones") ? searchParams.get("seaZones")!.split(",").filter(Boolean) : []),
    [searchParams],
  );
  function toggleSeaZone(zoneId: string, checked: boolean) {
    const next = checked ? [...seaZoneIds, zoneId] : seaZoneIds.filter((id) => id !== zoneId);
    // Clearing the last zone makes "include land" meaningless again — drop it so a later
    // zone pick doesn't silently inherit a stale "land off" from an unrelated earlier zone.
    // Both keys are updated in one call (see updateParams) so clearing the last zone can't
    // race with itself.
    updateParams({
      seaZones: next.length > 0 ? next.join(",") : null,
      ...(next.length === 0 ? { includeLand: null } : {}),
    });
  }
  const includeLand = searchParams.get("includeLand") !== "0";
  function setIncludeLand(checked: boolean) {
    updateParam("includeLand", checked ? null : "0");
  }
  function updateParam(key: string, value: string | null, options?: { replace?: boolean }) {
    updateParams({ [key]: value }, options);
  }
  // Two sequential setSearchParams calls in the same handler (e.g. clearing both `seaZones`
  // and `includeLand` together) each captured their own `prev` snapshot, so the second call
  // could silently clobber the first — this is what made "select all" impossible to uncheck,
  // and the last sea zone impossible to deselect. One functional update touching every changed
  // key at once removes the race entirely.
  //
  // replace defaults to false (a real history entry per change) — fine for a discrete, one-off
  // toggle like sort/group/taxon, where "undo via back button" is a reasonable side effect.
  // search passes replace: true instead, since typing fires one update per keystroke — without
  // it, every character typed would be its own back-button stop.
  function updateParams(updates: Record<string, string | null>, options?: { replace?: boolean }) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      return next;
    }, options);
  }

  // Other Taxa filter-option labels (e.g. "Insects" vs "Insecta") follow the same
  // species_naming_styles preference used everywhere else this session — self-fetched, same
  // pattern GroupedSpeciesGrid uses for its own group-label naming preference.
  const [namingStyles, setNamingStyles] = useState<string[]>([]);
  useEffect(() => {
    api.get<{ speciesNamingStyles: string[] }>("/settings").then((res) => setNamingStyles(res.speciesNamingStyles)).catch(() => {});
  }, []);

  // Arriving from the nav has no ?region= yet: the restore effect above adds it after the first
  // render. Looking the cache up by the region about to be restored lets that view draw at once,
  // instead of waiting for the region list and then the species list from the server.
  const cachedEntry = collectionCache.get(
    collectionCacheKey(regionId ?? (restoredLastRegion.current ? null : storedLastRegionId()), taxonFilters, seaZoneIds, includeLand),
  );
  const [items, setItems] = useState<CollectionItem[] | null>(cachedEntry?.items ?? null);
  const [regionMeta, setRegionMeta] = useState<RegionSpeciesResult["region"] | null>(cachedEntry?.regionMeta ?? null);
  const [regionStats, setRegionStats] = useState<RegionSpeciesResult["stats"] | null>(cachedEntry?.regionStats ?? null);
  // Set when the current region has no downloaded pack yet — see regions/routes.ts, which
  // never computes a checklist live. Distinct from `loadError`: this isn't a failure, it's a
  // real, expected state the UI offers a next step for.
  const [needsPackFor, setNeedsPackFor] = useState<{ id: string; name: string } | null>(null);
  // Set when a specific `?taxon=` filter is active and that taxon's pack isn't downloaded for
  // the current region (see regions/routes.ts's taxonPackMissing) — distinct from `needsPackFor`,
  // which means the region has NO pack at all; this means "some pack is here, just not this
  // taxon's," e.g. Canada's birds+mammals downloaded but not its fish.
  const [taxonPackMissingFor, setTaxonPackMissingFor] = useState<{ id: string; name: string; taxon: TaxonFilter } | null>(
    null,
  );
  // Resolves well before `items`/`regionStats` — a count-only query with none of the full
  // list's reference-photo/tier joins or per-row mapping — so the header total updates on a
  // region/taxon switch without waiting for the (much heavier) species grid to load.
  const [quickCount, setQuickCount] = useState<{ total: number; collected: number } | null>(null);
  const [allRegions, setAllRegions] = useState<RegionSummary[]>([]);
  // Set whenever the current view is a hub (World/continent) aggregate — distinguishes "zero
  // downloaded countries under here" (a real empty state) from "downloaded countries exist but
  // none of their species matched the current filter," which needs a different message.
  const [downloadedHubCountryNames, setDownloadedHubCountryNames] = useState<string[]>([]);
  const [drillingDown, setDrillingDown] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // In-view search filters whatever's already on screen (all species, or the current
  // region's checklist), not a separate global lookup like the header's SpeciesPicker (which
  // navigates away). A URL param (not plain component state) so it round-trips through real
  // browser back-navigation — opening a species from a filtered search and clicking back
  // restores the exact search instead of landing on an unfiltered list. Still cleared on an
  // actual region change (see the regionId effect below), same as before — a filter scoped to
  // the current view shouldn't carry over when drilling into a different region.
  const search = searchParams.get("search") ?? "";
  function setSearch(value: string) {
    updateParam("search", value || null);
  }
  const [seaZones, setSeaZones] = useState<Array<{ id: string; name: string }>>([]);

  // "Filters" consolidates the collected/seen/target-first toggles and the Show state select
  // behind one Pill+panel, same pattern GalleryPage's own Filters button already uses — these
  // five controls used to sit as their own separate labels/checkboxes directly in the toolbar
  // row, which read as cluttered next to Group/Sort/Taxon. Ghost/Lost-only (also filter
  // checkboxes, just conditionally shown) move in here too for the same reason.
  const [cardMinWidth, setCardMinWidth] = useSpeciesCardSize();
  // Purely a display preference (doesn't touch the underlying data) — persisted the same
  // lightweight way as the size slider, so it survives a reload without needing a real per-user
  // settings round trip. Hides every badge in a card's status row (global/local tier, Endemic,
  // Vagrant, Ghost, Lost, Rediscovered — see SpeciesCard.tsx), not just the tier ones, for a
  // user who just wants a cleaner card with no callouts at all.
  const [hideLabels, setHideLabels] = useState(() => {
    try {
      return localStorage.getItem("lifer:hideLabels") === "1";
    } catch {
      return false;
    }
  });
  function toggleHideLabels(next: boolean) {
    setHideLabels(next);
    try {
      localStorage.setItem("lifer:hideLabels", next ? "1" : "0");
    } catch {
      // Private browsing or storage disabled — the toggle still works this session.
    }
  }
  // "Hide names": photo-only cards. Same per-browser preference storage as Hide labels.
  const [hideNames, setHideNames] = useState(() => {
    try {
      return localStorage.getItem("lifer:hideNames") === "1";
    } catch {
      return false;
    }
  });
  function toggleHideNames(next: boolean) {
    setHideNames(next);
    try {
      localStorage.setItem("lifer:hideNames", next ? "1" : "0");
    } catch {
      // Storage disabled: the toggle still works this session.
    }
  }
  // Lets the map still be downloaded/kept without it eating screen space on every visit —
  // same lightweight localStorage persistence as the other display toggles above. Collapsed
  // state is global (not per-region), matching how the size slider and rarity-label toggle
  // already behave — one preference, not one saved per region.
  const [mapCollapsed, setMapCollapsed] = useState(() => {
    try {
      return localStorage.getItem("lifer:collectionMapCollapsed") === "1";
    } catch {
      return false;
    }
  });
  function toggleMapCollapsed() {
    setMapCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("lifer:collectionMapCollapsed", next ? "1" : "0");
      } catch {
        // Private browsing or storage disabled — the toggle still works this session.
      }
      return next;
    });
  }
  const mapAvailable = useMapAvailable();

  // collectedFirst defaults to true, so it only counts toward the badge when turned OFF
  // (the non-default state) — same "count only departures from default" rule Gallery's own
  // activeFilterCount uses. Taxon now lives inside this same Filters panel (see its own render
  // site below) instead of its own separate pill, matching Gallery's "everything behind one
  // Filters button" convention, so it counts toward this badge too.
  const activeFilterCount =
    (collectedFirst ? 0 : 1) +
    (seenFirst ? 1 : 0) +
    (targetFirst ? 1 : 0) +
    (stateFilter !== "all" ? 1 : 0) +
    (ghostOnly ? 1 : 0) +
    (lostOnly ? 1 : 0) +
    (likelyThisMonthOnly ? 1 : 0) +
    (yearFilter ? 1 : 0) +
    taxonFilters.size;

  // Fetched once, up front, independent of regionId — the region list is cheap (it's just
  // names/hierarchy, not species), and `load()` below needs to know whether the CURRENT
  // region actually has a scoped checklist before deciding whether to fetch one at all (see
  // regionsLoaded/regionKnownHub below), so this can't just be folded into `load()` itself
  // the way it used to be — that let the very first render, before this had a chance to
  // arrive, decide "unknown, so fetch everything" for a hub region exactly once too many.
  const [regionsLoaded, setRegionsLoaded] = useState(false);
  useEffect(() => {
    api
      .get<{ regions: RegionSummary[] }>("/regions")
      .then((res) => {
        setAllRegions(res.regions);
        setRegionsLoaded(true);
      })
      .catch(() => {
        setLoadError(true);
        setRegionsLoaded(true);
      });
  }, []);

  // Country-level packs are keyed by region NAME (see offlinePacks/routes.ts, build-region-
  // pack.ts's own comment on why — installs don't share region ids), so this is the only way
  // to connect a downloaded pack back to a row in `allRegions`. Sea-zone packs (region: null)
  // don't participate here at all — they're not part of the country/province browse tree.
  const [downloadedCountryNames, setDownloadedCountryNames] = useState<Set<string> | null>(null);
  // Per-country, which taxa actually have a downloaded pack (null in the inner set means an
  // all-taxa pack, which covers every taxon) — lets the sea-zone auto-select effect and the
  // taxon-pack prompt below tell "this taxon's pack isn't downloaded" apart from "downloaded,
  // genuinely empty," neither of which downloadedCountryNames alone can distinguish.
  const [downloadedRegionTaxons, setDownloadedRegionTaxons] = useState<Map<string, Set<string | null>> | null>(null);
  // Re-run after a pack download from this page so taxon gating and counts don't go stale.
  const loadDownloadedPacks = useCallback(() => {
    api
      .get<{ packs: Array<{ type: string; region: string | null; taxon: string | null; downloaded: boolean }> }>(
        "/offline-packs/index",
      )
      .then((res) => {
        setDownloadedCountryNames(
          new Set(res.packs.filter((p) => p.type === "region" && p.region && p.downloaded).map((p) => p.region!)),
        );
        const taxonMap = new Map<string, Set<string | null>>();
        for (const p of res.packs) {
          if (p.type !== "region" || !p.region || !p.downloaded) continue;
          if (!taxonMap.has(p.region)) taxonMap.set(p.region, new Set());
          taxonMap.get(p.region)!.add(p.taxon ?? null);
        }
        setDownloadedRegionTaxons(taxonMap);
      })
      .catch(() => {
        setDownloadedCountryNames(new Set());
        setDownloadedRegionTaxons(new Map());
      });
  }, []);
  useEffect(loadDownloadedPacks, [loadDownloadedPacks]);

  // Client-side mirror of regions/routes.ts's resolvePackRegionName — packs are always built
  // at country level, so a province's own name never appears in downloaded_packs; only its
  // direct parent (the country) does. Good enough for gating UI decisions defensively: if it
  // ever mismatches the server's own resolution, the worst case is skipping a helpful prompt
  // or auto-select, never showing data that isn't actually unlocked.
  //
  // Walks up until it finds the country itself (identified by its own sovereigntyGroup —
  // migration 065, set only on country rows, null for World/continents/provinces/informal
  // regions), not just one level up unconditionally. A plain one-level walk treated a
  // COUNTRY's own id as if it were a province (a country's own parent is its continent, not
  // another country), resolving e.g. Canada to "North America" — every isTaxonPackDownloaded
  // check for a country-level regionId then missed, so availableTaxonFilters silently
  // collapsed to just "All taxa" the moment you viewed a whole downloaded country instead of
  // a specific province.
  const packRegionNameFor = useCallback(
    (id: string): string | null => {
      let region = allRegions.find((r) => r.id === id);
      while (region && region.sovereigntyGroup == null && region.parentId) {
        const parent = allRegions.find((r) => r.id === region!.parentId);
        if (!parent) break;
        region = parent;
      }
      return region?.name ?? null;
    },
    [allRegions],
  );
  // Same walk-to-country logic as packRegionNameFor just above, but returns the region's id
  // (and name) rather than just a display string — SpeciesCard's own province-vs-country hide
  // picker needs the actual country region id to call POST /regions/:id/species/:id/hide with.
  const countryAncestorFor = useCallback(
    (id: string): { id: string; name: string } | null => {
      let region = allRegions.find((r) => r.id === id);
      while (region && region.sovereigntyGroup == null && region.parentId) {
        const parent = allRegions.find((r) => r.id === region!.parentId);
        if (!parent) break;
        region = parent;
      }
      return region ? { id: region.id, name: region.name } : null;
    },
    [allRegions],
  );
  // Only meaningful once allRegions has actually loaded — before then this briefly returns
  // null, which SpeciesCard treats as "no country to disambiguate against" (falls back to the
  // plain one-click hide), never a crash.
  const countryAncestor = useMemo(
    () => (regionId ? countryAncestorFor(regionId) : null),
    [regionId, countryAncestorFor],
  );
  const isTaxonPackDownloaded = useCallback(
    (id: string | null, taxonClass: string): boolean => {
      if (!id || !downloadedRegionTaxons) return false;
      const packRegionName = packRegionNameFor(id);
      if (!packRegionName) return false;
      const taxons = downloadedRegionTaxons.get(packRegionName);
      if (!taxons) return false;
      return taxons.has(null) || taxons.has(taxonClass);
    },
    [downloadedRegionTaxons, packRegionNameFor],
  );

  // Sea zones only ever add fish species (sea_zone_species is populated exclusively from
  // fish taxon keys), so the whole "include nearby water" control is dead weight — reveals
  // zero species — whenever the taxon filter is narrowed to birds or mammals. It's ALSO
  // pointless (and actively confusing) to offer "see nearby ocean fish" for a region whose own
  // native fish aren't even downloaded yet — showing a neighboring sea zone's fish before the
  // region's own fish pack is installed contradicts "download this region's pack to see its
  // data." Hidden in both cases, not just skipped for auto-select.
  const seaZonesRelevant =
    (taxonFilters.size === 0 || taxonFilters.has("actinopterygii")) &&
    (!regionId || isTaxonPackDownloaded(regionId, "actinopterygii"));

  // A region only has real reference data once a pack covers it — see regions/routes.ts's own
  // "never computes a checklist live" comment. Browsing shouldn't offer a region with nothing
  // behind it, so the drill-down tree is filtered to only what's actually reachable from a
  // downloaded country pack: the country itself, every province bundled inside its pack (all
  // descendants), and every ancestor up to World (so the path TO that country stays visible —
  // otherwise a downloaded Canada would have nothing above it to click through from).
  // `null` (packs not loaded yet) means "don't filter yet" rather than "filter out everything",
  // so the tree doesn't flash empty on every load before the pack list arrives.
  const availableRegionIds = useMemo(() => {
    if (!downloadedCountryNames) return null;
    const byId = new Map(allRegions.map((r) => [r.id, r]));
    const childrenOf = new Map<string, RegionSummary[]>();
    for (const r of allRegions) {
      if (r.parentId == null) continue;
      if (!childrenOf.has(r.parentId)) childrenOf.set(r.parentId, []);
      childrenOf.get(r.parentId)!.push(r);
    }
    const available = new Set<string>();
    for (const region of allRegions) {
      if (!downloadedCountryNames.has(region.name)) continue;
      available.add(region.id);
      // Walk up to World.
      let cursor: RegionSummary | undefined = region;
      while (cursor?.parentId) {
        available.add(cursor.parentId);
        cursor = byId.get(cursor.parentId);
      }
      // Walk down through every descendant (provinces/states bundled in the same pack).
      const stack = [...(childrenOf.get(region.id) ?? [])];
      while (stack.length) {
        const child = stack.pop()!;
        available.add(child.id);
        stack.push(...(childrenOf.get(child.id) ?? []));
      }
    }
    return available;
  }, [allRegions, downloadedCountryNames]);

  // Resolves the deferred first-run decision (see the restore-last-region effect above) once
  // the region list has actually arrived — the single-downloaded-country case is handled
  // uniformly below instead of here, since it applies every time someone lands back on the
  // unscoped root, not just on a brand new login.
  useEffect(() => {
    if (!pendingFirstRunDecision || !regionsLoaded) return;
    setPendingFirstRunDecision(false);
    setFirstRunPrompt(true);
  }, [pendingFirstRunDecision, regionsLoaded]);

  // Whenever exactly one country has ever been downloaded, the unscoped root ("All species"/
  // World, regionId === null) isn't really a useful place to land — there's only one region
  // with any real data at all, so jump straight into it instead of making the user click
  // through. Applies every time someone navigates back to the root this way (clearing the
  // region, or a fresh login), not just once — if a second pack gets downloaded later, this
  // naturally stops firing since downloadedCountryNames.size is no longer 1.
  useEffect(() => {
    if (!regionResolved || regionId || !downloadedCountryNames || downloadedCountryNames.size !== 1) return;
    const onlyName = [...downloadedCountryNames][0];
    const onlyCountry = allRegions.find((r) => r.name === onlyName);
    if (onlyCountry) navigateToRegion(onlyCountry.id);
  }, [regionResolved, regionId, downloadedCountryNames, allRegions]);

  // World and the continents are purely organizational: they have no GADM code of their own
  // (hasScopedChecklist false, see regions/routes.ts), so their "checklist" is literally
  // every species on Earth with no occurrence filter behind it. Landing on one of those
  // should show just the drill-down children, avoiding an unnecessary fetch/render of the
  // entire worldwide dataset while browsing toward a specific region.
  const regionKnownHub = useMemo(() => {
    if (!regionId || !regionsLoaded) return false;
    const region = allRegions.find((r) => r.id === regionId);
    return !!region && !region.hasScopedChecklist;
  }, [regionId, regionsLoaded, allRegions]);

  // Which taxon classes the CURRENT region's checklist actually has any species in — the
  // dropdown below shouldn't offer "Reptiles" for a region with no reptiles at all, same
  // reasoning as the sea-zone/pack-download gating elsewhere on this page. Null (no region, or
  // not fetched yet) means "don't restrict by presence," not "restrict to nothing."
  const [taxaPresentForRegion, setTaxaPresentForRegion] = useState<Set<string> | null>(null);
  const loadTaxaPresentForRegion = useCallback(() => {
    if (!regionId || regionKnownHub) {
      setTaxaPresentForRegion(null);
      return;
    }
    api
      .get<Record<string, string[]>>(`/regions/taxon-presence?regionIds=${regionId}`)
      .then((res) => setTaxaPresentForRegion(new Set(res[regionId] ?? [])))
      .catch(() => setTaxaPresentForRegion(null));
  }, [regionId, regionKnownHub]);
  useEffect(() => {
    loadTaxaPresentForRegion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionId, regionKnownHub]);

  // Downloaded ANYWHERE — used only for the no-region ("all species") view, where "available
  // for the selected region" doesn't apply; a taxon whose pack you've grabbed for at least one
  // region is worth offering here rather than hiding it entirely just because no region is
  // currently selected.
  const taxaDownloadedAnywhere = useMemo(() => {
    const set = new Set<string>();
    if (downloadedRegionTaxons) {
      for (const taxons of downloadedRegionTaxons.values()) {
        for (const t of taxons) if (t) set.add(t);
      }
    }
    return set;
  }, [downloadedRegionTaxons]);

  // Downloaded-and-relevant only — offering "Reptiles" when nothing's downloaded for them, or
  // when the selected region genuinely has none, is a dead end (an empty view with no obvious
  // reason why). The currently-selected value always stays visible even if it stops qualifying
  // (e.g. switching regions out from under it), so the dropdown never shows a value with no
  // matching option.
  //
  // A specific Other Taxa iconic-taxon group (e.g. "insecta") is a genuine, separate filter
  // value alongside the generic "Other Taxa" bucket — /regions/taxon-presence already returns
  // it (Other Taxa species store their iconic taxon's lowercased name directly in taxon_class,
  // so it comes back from that same DISTINCT taxon_class query with no extra endpoint needed).
  // Only offered with a region selected — Other Taxa has no pack/download concept to check
  // "downloaded anywhere" against for the no-region view, unlike the 18 real taxa above.
  const otherTaxaIconicFiltersPresent = useMemo(() => {
    if (!regionId || !taxaPresentForRegion) return [];
    return [...taxaPresentForRegion].filter((t) => !(t in TAXON_LABEL));
  }, [regionId, taxaPresentForRegion]);

  const availableTaxonFilters = useMemo(
    () =>
      [
        ...(Object.keys(TAXON_LABEL) as TaxonFilter[]).filter((t) => t !== "all" && t !== "other-taxa"),
        // Specific Other Taxa groups (e.g. "insecta"/"plantae") stand in for the old flat
        // "Other Taxa" catch-all, which is gone — every Other Taxa species already has its own
        // iconic taxon, so a single undifferentiated bucket never added anything the per-group
        // breakdown below didn't already cover.
        ...otherTaxaIconicFiltersPresent,
        ...taxonFilters,
      ].filter(
        (t, i, arr) => arr.indexOf(t) === i,
      ).filter((t) => {
        // No pack concept for other-taxa species (added one at a time, per region, via
        // Settings > Species & Import) — always offered, unlike the 18 real taxa which are
        // gated on actually having a downloaded pack for them.
        if (taxonFilters.has(t) || otherTaxaIconicFiltersPresent.includes(t)) return true;
        if (regionId) {
          return isTaxonPackDownloaded(regionId, t) && (!taxaPresentForRegion || taxaPresentForRegion.has(t));
        }
        return taxaDownloadedAnywhere.has(t);
      }),
    [regionId, taxonFilters, isTaxonPackDownloaded, taxaPresentForRegion, taxaDownloadedAnywhere, otherTaxaIconicFiltersPresent],
  );

  // Bumped on every load() so a slower, older response (e.g. from before an archive or a
  // filter change) can't overwrite the counts and list from the newer one.
  const loadGeneration = useRef(0);
  const load = useCallback(() => {
    const generation = ++loadGeneration.current;
    const current = () => generation === loadGeneration.current;
    setLoadError(false);
    const taxonQuery = taxonFilters.size === 0 ? "" : `taxon=${[...taxonFilters].join(",")}`;
    // Only sent when relevant (see seaZonesRelevant's comment) — a stale seaZoneIds param
    // left in the URL from a previous "all taxa" view shouldn't silently reapply once the
    // taxon filter narrows to birds/mammals, since it would filter to zero without the
    // now-hidden checkboxes to explain why.
    const seaZoneQuery = seaZonesRelevant && seaZoneIds.length > 0 ? `seaZoneIds=${seaZoneIds.join(",")}` : "";
    const includeLandQuery = seaZoneQuery && !includeLand ? "includeLand=0" : "";

    setQuickCount(null);
    setNeedsPackFor(null);
    setTaxonPackMissingFor(null);
    // Every hub (World, or a continent) has no scoped checklist of its own — but rather than
    // dead-ending on "pick a country," aggregate the checklists of whichever countries
    // underneath it actually have a pack downloaded (World's include every downloaded country
    // anywhere; a continent's are scoped to just its own). Zero downloaded countries under this
    // hub still means nothing to show — see the empty-state branch in the render below.
    if (regionId && regionKnownHub) {
      setSeaZones([]);
      setQuickCount(null);
      // Cleared now, not when the list arrives: the previous region's bar and map link stayed
      // up alongside this hub's own bar until then.
      setRegionMeta(null);
      setRegionStats(null);
      api
        .get<{ items: CollectionItem[]; downloadedCountryNames: string[] }>(
          `/regions/${regionId}/aggregate-species?${taxonQuery}`,
        )
        .then((res) => {
          if (!current()) return;
          setItems(res.items);
          setRegionMeta(null);
          setRegionStats(null);
          setDownloadedHubCountryNames(res.downloadedCountryNames);
          collectionCache.set(collectionCacheKey(regionId, taxonFilters, seaZoneIds, includeLand), {
            items: res.items,
            regionMeta: null,
            regionStats: null,
          });
        })
        .catch(() => {
          if (current()) setLoadError(true);
        });
    } else if (regionId) {
      api
        .get<{ total: number; collected: number }>(
          `/regions/${regionId}/species/count?${taxonQuery}&${seaZoneQuery}&${includeLandQuery}`,
        )
        .then((res) => {
          if (current()) setQuickCount(res);
        })
        .catch((err) => console.error("Couldn't load species counts", err));
      api
        .get<RegionSpeciesResponse>(
          `/regions/${regionId}/species?filter=all&${taxonQuery}&${seaZoneQuery}&${includeLandQuery}`,
        )
        .then((res) => {
          if (!current()) return;
          if (res.needsPack) {
            setItems(null);
            setRegionMeta(null);
            setRegionStats(null);
            setNeedsPackFor(res.region);
            return;
          }
          setItems(res.items);
          setRegionMeta(res.region);
          setRegionStats(res.stats);
          if (res.taxonPackMissing && singleTaxonFilter) {
            setTaxonPackMissingFor({ id: res.region.id, name: res.region.name, taxon: singleTaxonFilter });
          }
          collectionCache.set(collectionCacheKey(regionId, taxonFilters, seaZoneIds, includeLand), {
            items: res.items,
            regionMeta: res.region,
            regionStats: res.stats,
          });
        })
        .catch(() => {
          if (current()) setLoadError(true);
        });
      api
        .get<{ zones: Array<{ id: string; name: string }> }>(`/regions/${regionId}/sea-zones`)
        .then((res) => {
          if (current()) setSeaZones(res.zones);
        })
        .catch(() => {
          if (current()) setSeaZones([]);
        });
    } else if (!firstRunPrompt) {
      setSeaZones([]);
      const query = taxonQuery ? `?${taxonQuery}` : "";
      api
        .get<{ total: number; collected: number }>(`/collection/count${query}`)
        .then((res) => {
          if (current()) setQuickCount(res);
        })
        .catch((err) => console.error("Couldn't load species counts", err));
      api
        .get<{ items: CollectionItem[] }>(`/collection${query}`)
        .then((res) => {
          if (!current()) return;
          setItems(res.items);
          setRegionMeta(null);
          setRegionStats(null);
          collectionCache.set(collectionCacheKey(regionId, taxonFilters, seaZoneIds, includeLand), {
            items: res.items,
            regionMeta: null,
            regionStats: null,
          });
        })
        .catch(() => {
          if (current()) setLoadError(true);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seaZoneIds is an array; its
    // joined string is the real dependency (stable primitive, avoids reference-identity churn)
  }, [regionId, taxonFilters, seaZoneIds.join(","), includeLand, firstRunPrompt, regionKnownHub, allRegions]);

  // Archived species are excluded server-side (see apps/api/src/species/obscurity.ts's
  // NOT_ARCHIVED_SQL) — after an archive action succeeds, the simplest correct way to reflect
  // that is just re-running the same fetch this page already does on every filter change,
  // rather than hand-patching `items`/`quickCount` in two places and risking them drifting
  // out of sync with what the server would actually return.
  // Also re-fetches taxon presence, not just the species list — removing the last remaining
  // species of an Other Taxa iconic-taxon group (e.g. "Plants") for this region should make
  // that group's filter pill disappear too, and taxaPresentForRegion was otherwise only ever
  // refetched on a regionId change, going stale the instant a species is archived or removed.
  const handleArchived = useCallback(() => {
    load();
    loadTaxaPresentForRegion();
  }, [load, loadTaxaPresentForRegion]);

  // A pack just downloaded from this page changes which taxa are unlocked, not only the list.
  const handlePackDownloaded = useCallback(() => {
    load();
    loadDownloadedPacks();
    loadTaxaPresentForRegion();
  }, [load, loadDownloadedPacks, loadTaxaPresentForRegion]);

  // Narrowing to birds/mammals hides the sea-zone checkboxes entirely (see seaZonesRelevant),
  // so any zones/includeLand picked under "all taxa" would otherwise sit invisibly in the URL
  // and jump back into effect the moment the filter is widened again — clear them so the
  // hidden state doesn't outlive the UI that explains it.
  useEffect(() => {
    if (!seaZonesRelevant && seaZoneIds.length > 0) {
      updateParam("seaZones", null);
      updateParam("includeLand", null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seaZonesRelevant]);

  // A country with zero native fish of its own but real nearby reef/marine zones (e.g. a
  // small island whose fish are only ever reached via "include nearby water" — see
  // regions/routes.ts's marine-exclusion logic) would otherwise show an empty fish list by
  // default, with no visible reason why. Auto-checking the zone(s) surfaces that data
  // immediately instead of requiring the user to already know to look for the checkbox.
  // Tracked per-region in a ref (not the URL) so a later manual uncheck — which clears the
  // `seaZones` param entirely, identical in the URL to "never set" — doesn't get silently
  // re-applied on the next render.
  const autoSelectedSeaZoneRegions = useRef(new Set<string>());
  useEffect(() => {
    if (!regionId || regionKnownHub || !seaZonesRelevant) return;
    if (seaZones.length === 0 || seaZoneIds.length > 0) return;
    if (autoSelectedSeaZoneRegions.current.has(regionId)) return;
    // A 0 fish count here can mean two very different things: this region genuinely has no
    // native fish (the case this effect exists for), or its fish pack simply isn't downloaded
    // yet — indistinguishable from the count alone once fish became pack-gated. Only treat it
    // as "genuinely none" once the fish pack IS actually downloaded; otherwise a 0 caused by
    // gating would auto-turn-on nearby sea zones and surface real fish from any OTHER
    // downloaded sea-zone pack, before this region's own fish pack was ever installed.
    if (!isTaxonPackDownloaded(regionId, "actinopterygii")) return;
    autoSelectedSeaZoneRegions.current.add(regionId);

    api
      .get<{ total: number }>(`/regions/${regionId}/species/count?taxon=actinopterygii`)
      .then((res) => {
        if (res.total === 0) updateParam("seaZones", seaZones.map((z) => z.id).join(","));
      })
      .catch(() => {
        // Let the next render retry instead of treating a failed check as "has fish".
        autoSelectedSeaZoneRegions.current.delete(regionId);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seaZones is an array; length +
    // regionId together are the real dependency, same reasoning as seaZoneIds elsewhere here.
  }, [regionId, regionKnownHub, seaZonesRelevant, seaZones, seaZoneIds.length, isTaxonPackDownloaded]);

  useEffect(() => {
    if (!regionResolved || !regionsLoaded) return;
    load();
  }, [load, regionResolved, regionsLoaded]);

  const prevRegionId = useRef(regionId);
  useEffect(() => {
    // Cleared when the region actually changes, but NOT on first mount — a bookmarked/shared
    // `?region=X&search=Y` URL, or a browser-back restoring one, should still work as-is
    // rather than having its own search wiped out immediately after landing.
    if (prevRegionId.current !== regionId) {
      setSearch("");
      // A sea zone picked for one region (e.g. Egypt -> Red Sea) is meaningless for a
      // different region — same "actual change, not first mount" rule as search above.
      updateParam("seaZones", null);
    }
    prevRegionId.current = regionId;
  }, [regionId]);

  function navigateToRegion(id: string | null) {
    setFirstRunPrompt(false);
    updateParam("region", id);
  }

  const worldRegion = useMemo(() => allRegions.find((r) => r.parentId === null && r.name === "World"), [allRegions]);
  const allChildren = useMemo(() => allRegions.filter((r) => r.parentId === regionId), [allRegions, regionId]);
  const children = useMemo(
    () => (availableRegionIds ? allChildren.filter((r) => availableRegionIds.has(r.id)) : allChildren),
    [allChildren, availableRegionIds],
  );
  const breadcrumb = useMemo(() => {
    const byId = new Map(allRegions.map((r) => [r.id, r]));
    const trail: RegionSummary[] = [];
    let node = regionId ? byId.get(regionId) : undefined;
    while (node) {
      trail.unshift(node);
      node = node.parentId ? byId.get(node.parentId) : undefined;
    }
    return trail;
  }, [allRegions, regionId]);

  async function drillDown() {
    if (!regionId) return;
    setDrillingDown(true);
    try {
      await api.post(`/regions/${regionId}/drill-down`, {});
      load();
    } finally {
      setDrillingDown(false);
    }
  }

  // Ghost/Lost are rare enough that most photographers will never have one — only worth
  // surfacing the filter checkboxes at all once the current checklist actually contains one,
  // same "don't take up space nobody cares about" reasoning as the Stats page's own gating.
  const hasGhost = items ? items.some((i) => i.isGhost) : false;
  const hasLost = items ? items.some((i) => i.isLost) : false;

  // Every year that has at least one real capture somewhere in the current checklist — only
  // worth offering a year the user could actually pick something for, same "don't take up
  // space nobody cares about" reasoning as hasGhost/hasLost above. Sorted newest first, since
  // that's the direction a "how many species so far this year" check usually runs.
  const availableYears = useMemo(() => {
    if (!items) return [];
    const years = new Set<number>();
    for (const i of items) for (const y of i.capturedYears ?? []) years.add(y);
    return [...years].sort((a, b) => b - a);
  }, [items]);

  const visibleItems = useMemo(() => {
    if (!items) return null;
    let filtered =
      stateFilter === "all" ? items : stateFilter === "target" ? items.filter((i) => i.isTarget) : items.filter((i) => i.state === stateFilter);
    if (ghostOnly) filtered = filtered.filter((i) => i.isGhost);
    if (lostOnly) filtered = filtered.filter((i) => i.isLost);
    if (likelyThisMonthOnly) {
      // Likely = this month holds at least a third of an average month's share of the species'
      // sightings here. "Any sightings at all" kept nearly everything (a stray record lands in
      // most months), and comparing to the species' own peak month dropped year-round birds like
      // Bald Eagles outside their busiest season.
      const month = new Date().getMonth();
      filtered = filtered.filter((i) => {
        const months = i.seasonality;
        const total = months?.reduce((sum, v) => sum + v, 0) ?? 0;
        return total > 0 && months![month] / total >= 1 / 36;
      });
    }
    if (yearFilter) {
      const year = Number(yearFilter);
      filtered = filtered.filter((i) => i.capturedYears?.includes(year));
    }
    const query = search.trim().toLowerCase();
    if (query) {
      filtered = filtered.filter(
        (i) => (i.commonName ?? "").toLowerCase().includes(query) || i.scientificName.toLowerCase().includes(query),
      );
    }
    return filtered;
  }, [items, stateFilter, ghostOnly, lostOnly, likelyThisMonthOnly, yearFilter, search]);

  // Prefers the already-arrived full item list once it's in (it reflects any client-side
  // filtering nuance exactly), but falls back to the fast count-only fetch so the header
  // doesn't sit blank/stale while the heavier item list is still loading.
  const collectedCount = items ? items.filter((i) => i.state === "collected").length : (quickCount?.collected ?? 0);
  const totalCount = items ? items.length : (quickCount?.total ?? null);

  // World/continent hubs have no single checklist of their own (see the aggregate-species fetch
  // above) — regionStats stays null for them, so the breadcrumb progress bar below computes its
  // own collected/seen/total straight from the aggregated items instead of waiting on a server
  // stats object that will never arrive for a hub.
  const hubStats = useMemo(() => {
    if (!regionKnownHub || !items) return null;
    let collected = 0;
    let seen = 0;
    for (const i of items) {
      if (i.state === "collected") collected++;
      else if (i.state === "seen") seen++;
    }
    return { collected, seen, total: items.length };
  }, [regionKnownHub, items]);

  return (
    <div className="min-h-screen bg-canvas">
      <AppNav collectedCount={collectedCount} totalCount={totalCount} />

      {/* Region breadcrumb — the main-screen drill-down entry point. */}
      <div className="border-b border-line bg-surface px-6 py-2">
        {!regionId ? (
          worldRegion && (
            <button onClick={() => navigateToRegion(worldRegion.id)} className="text-sm text-muted hover:underline">
              Browse by region →
            </button>
          )
        ) : (
          <div className="space-y-2">
            <nav className="flex flex-wrap items-center gap-1 text-sm text-muted">
              <button onClick={() => navigateToRegion(null)} className="hover:underline">
                All species
              </button>
              {breadcrumb.map((r, i) => (
                <span key={r.id} className="flex items-center gap-1">
                  <span className="text-muted">/</span>
                  {i === breadcrumb.length - 1 ? (
                    <span className="font-medium text-ink">{r.name}</span>
                  ) : (
                    <button onClick={() => navigateToRegion(r.id)} className="hover:underline">
                      {r.name}
                    </button>
                  )}
                </span>
              ))}
              {/* Inline with the breadcrumb rather than its own section below — a map toggle is
                 page chrome, not a species filter, so it doesn't belong in the Filters dropdown
                 either; living here means collapsing it doesn't leave behind a whole empty
                 section's worth of vertical rhythm the way a standalone block would. */}
              {regionMeta && !regionKnownHub && !!regionMeta.boundaryGeoJson && mapAvailable && (
                <button onClick={toggleMapCollapsed} className="ml-2 text-xs hover:underline">
                  {mapCollapsed ? "▸ Show map" : "▾ Hide map"}
                </button>
              )}
            </nav>
            {regionMeta && regionStats && !regionKnownHub && (
              <div className="flex items-center gap-3">
                <div className="h-1.5 w-40 overflow-hidden rounded-full bg-surface-muted">
                  <div
                    className="h-full bg-accent"
                    style={{ width: `${regionStats.total ? Math.round((regionStats.collected / regionStats.total) * 100) : 0}%` }}
                  />
                </div>
                <p className="text-xs text-muted">
                  {regionStats.collected} collected · {regionStats.seen} seen · {regionStats.total} total
                </p>
                {regionMeta.ebirdRegionCode && (taxonFilters.size === 0 || taxonFilters.has("aves")) && (
                  <a
                    href={`https://ebird.org/region/${regionMeta.ebirdRegionCode}/illustrated-checklist`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-muted hover:underline"
                  >
                    eBird Illustrated Checklist ↗
                  </a>
                )}
              </div>
            )}
            {regionKnownHub && hubStats && (
              <div className="flex items-center gap-3">
                <div className="h-1.5 w-40 overflow-hidden rounded-full bg-surface-muted">
                  <div
                    className="h-full bg-accent"
                    style={{ width: `${hubStats.total ? Math.round((hubStats.collected / hubStats.total) * 100) : 0}%` }}
                  />
                </div>
                <p className="text-xs text-muted">
                  {hubStats.collected} collected · {hubStats.seen} seen · {hubStats.total} total{" "}
                  <span title="Only counts checklists for countries you've downloaded, not every species in this region.">
                    (downloaded countries only)
                  </span>
                </p>
              </div>
            )}
            {(children.length > 0 || (regionMeta?.canDrillDown && !regionMeta.hasChildren)) && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs uppercase tracking-wide text-muted">Drill in:</span>
                {children.map((child) => (
                  <button
                    key={child.id}
                    onClick={() => navigateToRegion(child.id)}
                    className="rounded-md border border-line px-3 py-1 text-sm text-ink hover:bg-surface-muted"
                  >
                    {child.name}
                  </button>
                ))}
                {regionMeta?.canDrillDown && !regionMeta.hasChildren && (
                  <button
                    onClick={drillDown}
                    disabled={drillingDown}
                    className="rounded-md border border-line px-3 py-1 text-sm text-muted hover:bg-surface-muted disabled:opacity-50"
                  >
                    {drillingDown ? "Loading provinces/states…" : "Show provinces/states"}
                  </button>
                )}
              </div>
            )}
            {availableRegionIds && allChildren.length > 0 && children.length === 0 && (
              <p className="text-xs text-muted">
                None of this region's countries have a downloaded pack yet.{" "}
                <Link to="/offline-packs" state={{ backLabel: "Collection" }} className="underline">
                  Download one in Offline packs
                </Link>{" "}
                to see it here.
              </p>
            )}
          </div>
        )}
      </div>

      <div
        data-header-extension=""
        className="relative flex flex-wrap items-center gap-3 border-b border-line bg-surface py-2 pl-6 pr-12 text-xs"
      >
        <SearchInput value={search} onChange={setSearch} placeholder="Search this area…" className="w-48" />
        <Select
          label="Group"
          value={groupBy}
          onChange={(e) => {
            const value = e.target.value === "none" ? null : e.target.value;
            startGroupingTransition(() => updateParam("group", value));
          }}
        >
          <option value="none">No grouping</option>
          <option value="group">Family group</option>
          <option value="tier">Rarity tier</option>
          {/* Only meaningful with a region selected — see the matching "Rarity here" sort
             option's own comment. */}
          {regionId && <option value="localTier">Rarity here</option>}
        </Select>
        <Select
          label="Sort"
          value={sortBy}
          onChange={(e) => {
            const value = e.target.value === "taxonomic" ? null : e.target.value;
            startGroupingTransition(() => updateParam("sort", value));
          }}
        >
            <option value="taxonomic">Taxonomic</option>
            <option value="name">Name</option>
            <option value="rarity">Rarity</option>
            {/* Only meaningful with a region selected — localTier only comes back from
               GET /regions/:id/species, never plain GET /collection (see CollectionItem's
               own comment) — so this option would just silently do nothing without one. */}
            {regionId && <option value="localRarity">Rarity here</option>}
            {/* Same region-only gate as localRarity above - seasonality only ever comes back
               from GET /regions/:id/species (region_species.seasonality, a 12-entry MONTHLY
               array - see GroupedSpeciesGrid's currentMonthIndex). */}
            {regionId && <option value="seasonality">Most likely this month</option>}
        </Select>
        <label className="flex items-center gap-1.5 text-xs text-muted">
          Size
          <input
            type="range"
            min={120}
            max={320}
            step={10}
            value={cardMinWidth}
            onChange={(e) => setCardMinWidth(Number(e.target.value))}
            className="w-24 accent-ink"
            aria-label="Species card size"
          />
        </label>
        <FilterPopover activeCount={activeFilterCount}>
          {/* Taxon lives here (not its own separate pill) to match Gallery's own "everything
             behind one Filters button" convention. */}
          <div className="space-y-1">
            <FilterFieldLabel>Taxon</FilterFieldLabel>
            <div className="flex max-h-56 flex-wrap gap-1 overflow-y-auto">
              {availableTaxonFilters.map((t) => (
                <Pill
                  key={t}
                  size="sm"
                  active={taxonFilters.has(t)}
                  onClick={() => {
                    const next = new Set(taxonFilters);
                    if (next.has(t)) next.delete(t);
                    else next.add(t);
                    updateParam("taxon", next.size > 0 ? [...next].join(",") : null);
                  }}
                >
                  {taxonFilterLabel(t, namingStyles)}
                </Pill>
              ))}
            </div>
            {taxonFilters.size > 0 && (
              <button onClick={() => updateParam("taxon", null)} className="pt-1 text-[11px] text-muted hover:underline">
                Clear taxon filter
              </button>
            )}
          </div>
          <div className="space-y-1.5 border-t border-line pt-2">
            <label className="flex items-center gap-1.5 text-xs text-ink">
              <input
                type="checkbox"
                checked={collectedFirst}
                onChange={(e) => updateParam("collectedFirst", e.target.checked ? null : "0")}
                className="accent-accent"
              />
              Collected first
            </label>
            <label className="flex items-center gap-1.5 text-xs text-ink">
              <input
                type="checkbox"
                checked={seenFirst}
                onChange={(e) => updateParam("seenFirst", e.target.checked ? "1" : null)}
                className="accent-accent"
              />
              Seen first
            </label>
            <label className="flex items-center gap-1.5 text-xs text-ink">
              <input
                type="checkbox"
                checked={targetFirst}
                onChange={(e) => updateParam("targetFirst", e.target.checked ? "1" : null)}
                className="accent-accent"
              />
              Targets first
            </label>
            <label className="flex items-center gap-1.5 text-xs text-ink">
              <input
                type="checkbox"
                checked={hideLabels}
                onChange={(e) => toggleHideLabels(e.target.checked)}
                className="accent-accent"
              />
              Hide labels
            </label>
            <label className="flex items-center gap-1.5 text-xs text-ink">
              <input
                type="checkbox"
                checked={hideNames}
                onChange={(e) => toggleHideNames(e.target.checked)}
                className="accent-accent"
              />
              Hide names
            </label>
          </div>
          <div className="border-t border-line pt-2">
            <FilterFieldLabel>Show</FilterFieldLabel>
            <Select
              value={stateFilter}
              onChange={(e) => updateParam("show", e.target.value === "all" ? null : e.target.value)}
              className="w-full"
            >
              <option value="all">All</option>
              <option value="collected">Collected</option>
              <option value="seen">Seen only</option>
              <option value="target">Targets</option>
              <option value="unseen">Not yet collected</option>
            </Select>
          </div>
          {(regionId || availableYears.length > 0) && (
            <div className="space-y-1.5 border-t border-line pt-2">
              {regionId && (
                <label
                  className="flex items-center gap-1.5 text-xs text-ink"
                  title="Ranks this region's own seasonal frequency data for the current month"
                >
                  <input
                    type="checkbox"
                    checked={likelyThisMonthOnly}
                    onChange={(e) => updateParam("likelyThisMonth", e.target.checked ? "1" : null)}
                    className="accent-accent"
                  />
                  Likely this month
                </label>
              )}
              {availableYears.length > 0 && (
                <div className="space-y-1">
                  <FilterFieldLabel>Found in year</FilterFieldLabel>
                  <Select value={yearFilter} onChange={(e) => updateParam("year", e.target.value || null)} className="w-full">
                    <option value="">Any year</option>
                    {availableYears.map((y) => (
                      <option key={y} value={y}>
                        {y}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
            </div>
          )}
          {(hasGhost || hasLost) && (
            <div className="space-y-1.5 border-t border-line pt-2">
              {hasGhost && (
                <label
                  className="flex items-center gap-1.5 text-xs text-ink"
                  title="Rarely documented anywhere, but still out there to find"
                >
                  <input
                    type="checkbox"
                    checked={ghostOnly}
                    onChange={(e) => updateParam("ghostOnly", e.target.checked ? "1" : null)}
                    className="accent-accent"
                  />
                  Ghost only
                </label>
              )}
              {hasLost && (
                <label
                  className="flex items-center gap-1.5 text-xs text-ink"
                  title="Not recorded anywhere in over 25 years"
                >
                  <input
                    type="checkbox"
                    checked={lostOnly}
                    onChange={(e) => updateParam("lostOnly", e.target.checked ? "1" : null)}
                    className="accent-accent"
                  />
                  Lost only
                </label>
              )}
            </div>
          )}
        </FilterPopover>
        {seaZonesRelevant && seaZones.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-muted">
            <span>Include nearby water:</span>
            {seaZones.length > 1 && (
              <label className="flex items-center gap-1 font-medium text-ink">
                <input
                  type="checkbox"
                  checked={seaZoneIds.length === seaZones.length}
                  onChange={(e) =>
                    updateParams({
                      seaZones: e.target.checked ? seaZones.map((z) => z.id).join(",") : null,
                      ...(e.target.checked ? {} : { includeLand: null }),
                    })
                  }
                />
                Select all
              </label>
            )}
            {seaZones.map((z) => (
              <label key={z.id} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={seaZoneIds.includes(z.id)}
                  onChange={(e) => toggleSeaZone(z.id, e.target.checked)}
                />
                {z.name}
              </label>
            ))}
            {/* Only meaningful once a zone is checked — otherwise there's nothing to
               exclude land in favor of. Lets a checked zone (e.g. Red Sea) show only that
               zone's fish instead of always adding to the region's own land/freshwater
               checklist. */}
            {seaZoneIds.length > 0 && (
              <label className="flex items-center gap-1 border-l border-line pl-2">
                <input type="checkbox" checked={includeLand} onChange={(e) => setIncludeLand(e.target.checked)} />
                Include {regionMeta?.name ?? "region"}'s own species
              </label>
            )}
          </div>
        )}
      </div>

      <main className="space-y-6 p-6">
        {regionId && regionMeta && !!regionMeta.boundaryGeoJson && mapAvailable && !mapCollapsed && (
          <RegionMap boundaryGeoJson={regionMeta.boundaryGeoJson} regionKey={regionMeta.id} />
        )}

        {firstRunPrompt ? (
          <div className="rounded-xl border border-line bg-surface p-8 text-center">
            <h2 className="text-lg font-semibold text-ink">Welcome to Lifer</h2>
            <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
              Download a region's offline pack to see its checklist and start tracking what you've photographed
              there.
            </p>
            <div className="mt-4 flex items-center justify-center gap-4">
              <Link
                to="/offline-packs"
                state={{ backLabel: "Collection" }}
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg"
              >
                Download a pack
              </Link>
            </div>
          </div>
        ) : regionKnownHub && items && items.length === 0 && downloadedHubCountryNames.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line bg-surface-muted p-6 text-center">
            <p className="text-sm font-medium text-ink">No downloaded countries here yet</p>
            <p className="mt-1 text-sm text-muted">
              Pick a country above, or download one from{" "}
              <Link to="/offline-packs" state={{ backLabel: "Collection" }} className="underline">
                Offline packs
              </Link>
              .
            </p>
          </div>
        ) : needsPackFor ? (
          <NeedsPackPrompt region={needsPackFor} onDownloaded={handlePackDownloaded} />
        ) : loadError ? (
          <EmptyState
            icon={
              <svg viewBox="0 0 24 24" className="h-6 w-6 text-muted" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v5M12 16h.01" />
              </svg>
            }
            title="Couldn't load this view"
            description="Something went wrong fetching your collection. Try again."
            action={{ label: "Retry", onClick: load }}
          />
        ) : !visibleItems ? (
          <Spinner />
        ) : taxonPackMissingFor &&
          taxonPackMissingFor.id === regionId &&
          taxonPackMissingFor.taxon === singleTaxonFilter &&
          visibleItems.length === 0 ? (
          <TaxonPackPrompt
            regionId={taxonPackMissingFor.id}
            regionName={taxonPackMissingFor.name}
            taxon={taxonPackMissingFor.taxon}
            onDownloaded={handlePackDownloaded}
          />
        ) : visibleItems.length === 0 ? (
          <p className="text-muted">Nothing matches that filter.</p>
        ) : (
          <div className={isGroupingPending ? "opacity-60 transition-opacity" : "transition-opacity"}>
            <GroupedSpeciesGrid
              items={visibleItems}
              regionId={regionId ?? undefined}
              groupBy={groupBy}
              sortBy={sortBy}
              collectedFirst={collectedFirst}
              seenFirst={seenFirst}
              targetFirst={targetFirst}
              onArchived={handleArchived}
              cardMinWidth={cardMinWidth}
              regionName={regionMeta?.name}
              countryRegionId={countryAncestor?.id}
              countryRegionName={countryAncestor?.name}
              hideLabels={hideLabels}
              hideNames={hideNames}
            />
          </div>
        )}
      </main>
    </div>
  );
}

interface OfflinePackEntry {
  id: string;
  type: "region" | "seaZone";
  region?: string;
  seaZone?: string;
  taxon?: string | null;
  sizeBytes: number;
  speciesCount: number;
  downloaded: boolean;
}

// Shown instead of a checklist for a region with no downloaded pack — see regions/routes.ts,
// which never computes this live. Finds the matching "all taxa" pack for this region in the
// index and offers a direct download, rather than sending the user off to the Offline Packs
// settings page for what's usually a single, obvious action.
function NeedsPackPrompt({ region, onDownloaded }: { region: { id: string; name: string }; onDownloaded: () => void }) {
  const [pack, setPack] = useState<OfflinePackEntry | null | undefined>(undefined);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPack(undefined);
    api
      .get<{ packs: OfflinePackEntry[] }>("/offline-packs/index")
      .then((res) => setPack(res.packs.find((p) => p.type === "region" && p.region === region.name) ?? null))
      .catch(() => setPack(null));
  }, [region.name]);

  async function download() {
    if (!pack) return;
    setDownloading(true);
    setError(null);
    try {
      await api.post("/offline-packs/download", { packIds: [pack.id] });
      // Same short-poll pattern as OfflinePacksPage — a pack download runs as a background
      // job, not something this POST itself waits on.
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        const status = await api.get<{ running: boolean; error: string | null }>("/offline-packs/download/status");
        if (!status.running) {
          if (status.error) setError(status.error);
          break;
        }
      }
      onDownloaded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't download this pack");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-8 text-center">
      <h2 className="text-lg font-semibold text-ink">{region.name}'s checklist isn't downloaded yet</h2>
      {pack === undefined ? (
        <p className="mt-2 text-sm text-muted">Checking for a pack…</p>
      ) : pack === null ? (
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
          No offline pack is published for {region.name} yet. Check{" "}
          <Link to="/offline-packs" state={{ backLabel: "Collection" }} className="underline">
            Offline packs
          </Link>{" "}
          later, or ask whoever runs this Lifer instance about it.
        </p>
      ) : (
        <>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
            {pack.speciesCount} species, {formatBytes(pack.sizeBytes)}.
          </p>
          <button
            onClick={download}
            disabled={downloading}
            className="mt-4 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
          >
            {downloading ? "Downloading…" : `Download ${region.name}'s pack`}
          </button>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        </>
      )}
    </div>
  );
}

// Shown instead of an empty grid when a taxon filter (Birds/Mammals/Fish) is narrowed to a
// region that has SOME pack downloaded, just not this taxon's — see regions/routes.ts's
// taxonPackMissing. Packs are taxon-split per country (see build-region-pack.ts), so this
// looks for a pack matching both the region name AND this specific taxon, falling back to an
// all-taxa pack (taxon: null) if that's what this install actually publishes.
function TaxonPackPrompt({
  regionId,
  regionName,
  taxon,
  onDownloaded,
}: {
  regionId: string;
  regionName: string;
  taxon: TaxonFilter;
  onDownloaded: () => void;
}) {
  const [pack, setPack] = useState<OfflinePackEntry | null | undefined>(undefined);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Fish specifically can ALSO be reached via a nearby sea zone's own separate pack (see
  // CollectionPage's seaZonesRelevant/isTaxonPackDownloaded) — without offering that here too,
  // this screen was a dead end for anyone whose actual interest is "nearby ocean fish," not
  // this region's own native freshwater/coastal species.
  const [seaZonePacks, setSeaZonePacks] = useState<Array<{ zoneId: string; zoneName: string; pack: OfflinePackEntry }> | null>(
    null,
  );
  const [downloadingZoneId, setDownloadingZoneId] = useState<string | null>(null);
  const [zoneError, setZoneError] = useState<string | null>(null);
  const [otherTaxaModalOpen, setOtherTaxaModalOpen] = useState(false);

  useEffect(() => {
    // Other Taxa never has a real pack to find — species land here one at a time via the
    // any-taxa search, not a bulk region download — so skip the pack lookup entirely and go
    // straight to the manual-add explanation below. A specific iconic-taxon group (e.g.
    // "insecta") is still Other Taxa under the hood — same no-pack rule applies to it too.
    if (taxon === "other-taxa" || !(taxon in TAXON_LABEL)) {
      setPack(null);
      setSeaZonePacks([]);
      return;
    }
    setPack(undefined);
    setSeaZonePacks(null);
    Promise.all([
      api.get<{ packs: OfflinePackEntry[] }>("/offline-packs/index"),
      taxon === "actinopterygii"
        ? api.get<{ zones: Array<{ id: string; name: string }> }>(`/regions/${regionId}/sea-zones`)
        : Promise.resolve({ zones: [] }),
    ])
      .then(([{ packs }, { zones }]) => {
        const candidates = packs.filter((p) => p.type === "region" && p.region === regionName);
        setPack(candidates.find((p) => p.taxon === taxon) ?? candidates.find((p) => !p.taxon) ?? null);

        const zonePacks = zones
          .map((zone) => ({ zoneId: zone.id, zoneName: zone.name, pack: packs.find((p) => p.type === "seaZone" && p.seaZone === zone.name) }))
          .filter((z): z is { zoneId: string; zoneName: string; pack: OfflinePackEntry } => !!z.pack && !z.pack.downloaded);
        setSeaZonePacks(zonePacks);
      })
      .catch(() => {
        setPack(null);
        setSeaZonePacks([]);
      });
  }, [regionId, regionName, taxon]);

  async function download() {
    if (!pack) return;
    setDownloading(true);
    setError(null);
    try {
      await api.post("/offline-packs/download", { packIds: [pack.id] });
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        const status = await api.get<{ running: boolean; error: string | null }>("/offline-packs/download/status");
        if (!status.running) {
          if (status.error) setError(status.error);
          break;
        }
      }
      onDownloaded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't download this pack");
    } finally {
      setDownloading(false);
    }
  }

  async function downloadZone(zoneId: string, packId: string) {
    setDownloadingZoneId(zoneId);
    setZoneError(null);
    try {
      await api.post("/offline-packs/download", { packIds: [packId] });
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        const status = await api.get<{ running: boolean; error: string | null }>("/offline-packs/download/status");
        if (!status.running) {
          if (status.error) setZoneError(status.error);
          break;
        }
      }
      setSeaZonePacks((prev) => prev?.filter((z) => z.zoneId !== zoneId) ?? null);
      onDownloaded();
    } catch (err) {
      setZoneError(err instanceof ApiError ? err.message : "Couldn't download this pack");
    } finally {
      setDownloadingZoneId(null);
    }
  }

  if (taxon === "other-taxa" || !(taxon in TAXON_LABEL)) {
    return (
      <div className="rounded-xl border border-line bg-surface p-8 text-center">
        <h2 className="text-lg font-semibold text-ink">No Other Taxa added for {regionName} yet</h2>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
          There's no pack to download for this one, Other Taxa covers whatever Lifer doesn't already have a
          dataset for (insects, plants, fungi, and more). Jump to a species by scientific name (that matches
          best) and you'll get the option to search iNaturalist and add it here, or paste in a whole list of
          names at once from the same search screen.
        </p>
        <button
          onClick={() => setOtherTaxaModalOpen(true)}
          className="mt-4 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg"
        >
          Search iNaturalist
        </button>
        {otherTaxaModalOpen && (
          <AddOtherTaxaModal
            initialQuery=""
            initialRegionId={regionId}
            onClose={() => setOtherTaxaModalOpen(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-8 text-center">
      <h2 className="text-lg font-semibold text-ink">
        {regionName}'s {taxonFilterLabel(taxon, []).toLowerCase()} pack isn't downloaded yet
      </h2>
      {pack === undefined ? (
        <p className="mt-2 text-sm text-muted">Checking for a pack…</p>
      ) : pack === null ? (
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
          No offline pack covers {regionName}'s {taxonFilterLabel(taxon, []).toLowerCase()} yet. Check{" "}
          <Link to="/offline-packs" state={{ backLabel: "Collection" }} className="underline">
            Offline packs
          </Link>{" "}
          later.
        </p>
      ) : (
        <>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
            {pack.speciesCount} species, {formatBytes(pack.sizeBytes)}.
          </p>
          <button
            onClick={download}
            disabled={downloading}
            className="mt-4 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
          >
            {downloading ? "Downloading…" : "Download Now"}
          </button>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        </>
      )}
      {seaZonePacks !== null && seaZonePacks.length > 0 && (
        <div className="mx-auto mt-6 max-w-sm border-t border-line pt-4 text-left">
          <p className="text-sm text-muted">
            Or get fish from a nearby sea zone instead — a separate, optional download, not part of {regionName}'s
            own pack above:
          </p>
          <div className="mt-3 space-y-2">
            {seaZonePacks.map((zone) => (
              <div key={zone.zoneId} className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2">
                <span className="text-sm text-ink">
                  {zone.zoneName} <span className="text-muted">({zone.pack.speciesCount} species)</span>
                </span>
                <button
                  onClick={() => downloadZone(zone.zoneId, zone.pack.id)}
                  disabled={downloadingZoneId !== null}
                  className="shrink-0 rounded-md border border-line px-3 py-1 text-xs font-medium text-ink disabled:opacity-50"
                >
                  {downloadingZoneId === zone.zoneId ? "Downloading…" : "Download"}
                </button>
              </div>
            ))}
          </div>
          {zoneError && <p className="mt-2 text-sm text-red-600">{zoneError}</p>}
        </div>
      )}
    </div>
  );
}
