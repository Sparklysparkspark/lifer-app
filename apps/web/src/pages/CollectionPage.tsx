import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { CollectionItem, RegionSpeciesResponse, RegionSpeciesResult, RegionSummary } from "@lifer/shared";
import { api, ApiError } from "../api/client";
import { useAuth } from "../hooks/useAuth";
import { useDesktopMode } from "../hooks/useDesktopMode";
import SpeciesPicker from "../components/SpeciesPicker";
import CollectionStatsPanel from "../components/CollectionStats";
import GroupedSpeciesGrid, { type GroupBy, type SortBy } from "../components/GroupedSpeciesGrid";
import RegionMap from "../components/RegionMap";
import { Logo } from "../components/Logo";
import InfoTip from "../components/InfoTip";
import { Spinner } from "../components/LoadingScreen";

const RARITY_INFO_PARAGRAPHS = [
  '"Rarity" ranks how hard a species is to get a good photo of overall. It\'s not conservation status. A common species that\'s hard to photograph can rank higher than an endangered species that\'s easy to photograph.',
  '"Rarity here" is a completely different, region-specific measure. It\'s how often that species actually turns up in the region you\'ve selected, based on real sighting records for that area.',
];

type StateFilter = "all" | "collected" | "seen" | "unseen";
type TaxonFilter = "all" | "aves" | "mammalia" | "actinopterygii";

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
function collectionCacheKey(
  regionId: string | null,
  taxonFilter: TaxonFilter,
  seaZoneIds: string[],
  includeLand: boolean,
): string {
  return JSON.stringify([regionId, taxonFilter, [...seaZoneIds].sort(), includeLand]);
}

const TAXON_LABEL: Record<TaxonFilter, string> = {
  all: "All taxa",
  aves: "Birds",
  mammalia: "Mammals",
  actinopterygii: "Fish",
};

// Region drill-down lives on the main screen — no region selected means "everything
// collected, worldwide"; picking one (via the breadcrumb below) narrows the same grid to
// that region's checklist without ever leaving this page. `?region=` is a real URL param so
// a drilled-in view is bookmarkable/shareable, same idea as SpeciesDetailPage's `?regionId=`.
export default function CollectionPage() {
  const { user, logout } = useAuth();
  const isDesktopMode = useDesktopMode();
  // Every filter/sort/group preference lives in the URL, not plain useState, so sorting and
  // grouping choices never get lost just from navigating between regions, and a specific
  // filtered/grouped view stays shareable and bookmarkable, same as `region` already was.
  const [searchParams, setSearchParams] = useSearchParams();
  const regionId = searchParams.get("region");

  // Opening Lifer fresh (no ?region= in the URL at all) used to default to "every species in
  // the world," which tries to load the full worldwide checklist rather than the region a
  // user actually cares about. Restores the last-viewed region from
  // localStorage exactly once, on first mount — never overrides a URL that's already there
  // (a bookmarked/shared link, or a deliberate navigation back to World within this session),
  // and never fights a user who explicitly clears the region afterward.
  //
  // A genuinely first-ever login (fresh account, so no lastRegionId has ever been stored) has
  // nothing to restore — that's the case the fix above doesn't cover, and where "every
  // species in the world" was still silently loading on load. firstRunPrompt covers that gap:
  // when true, `load()` skips the worldwide fetch and the region grid below shows a "browse
  // by region to get started" prompt instead, until the user actually picks something.
  //
  // regionResolved gates the fetch-triggering effect further down until THIS effect has had a
  // chance to run — without it, the very first render (before this effect's restore/prompt
  // decision lands) still has regionId=null and firstRunPrompt=false, and `load()` would fire
  // the full worldwide fetch on that render before ever getting overridden.
  const restoredLastRegion = useRef(false);
  const [firstRunPrompt, setFirstRunPrompt] = useState(false);
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
      if (lastRegionId) updateParam("region", lastRegionId);
      else setFirstRunPrompt(true);
    } catch {
      // localStorage can throw in some contexts (private browsing, disabled storage) — a
      // missed restore just falls back to the old "show everything" default, not an error.
    }
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
  // "Collected first" and "Seen first" (everything shown, collected/seen pinned at top) are
  // independent toggles — either can be on alone, or both (collected always pins above seen
  // when both are on; see GroupedSpeciesGrid's floatRank). Distinct from the "Show: Collected
  // only" filter (which defaults to "All" below). No param at all means checked for
  // collectedFirst (on by default) and unchecked for seenFirst (off by default) — explicitly
  // toggling either writes its own `=0`/`=1` into the URL so it's distinguishable from the
  // default.
  const collectedFirst = searchParams.get("collectedFirst") !== "0";
  const seenFirst = searchParams.get("seenFirst") === "1";
  const stateFilter = (searchParams.get("show") as StateFilter) || "all";
  const taxonFilter = (searchParams.get("taxon") as TaxonFilter) || "all";
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
  // Sea zones only ever add fish species (sea_zone_species is populated exclusively from
  // fish taxon keys), so the whole "include nearby water" control is dead weight — reveals
  // zero species — whenever the taxon filter is narrowed to birds or mammals. The toggle is
  // hidden in that case since it wouldn't reveal any data.
  const seaZonesRelevant = taxonFilter === "all" || taxonFilter === "actinopterygii";
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

  const cachedEntry = collectionCache.get(collectionCacheKey(regionId, taxonFilter, seaZoneIds, includeLand));
  const [items, setItems] = useState<CollectionItem[] | null>(cachedEntry?.items ?? null);
  const [regionMeta, setRegionMeta] = useState<RegionSpeciesResult["region"] | null>(cachedEntry?.regionMeta ?? null);
  const [regionStats, setRegionStats] = useState<RegionSpeciesResult["stats"] | null>(cachedEntry?.regionStats ?? null);
  // Set when the current region has no downloaded pack yet — see regions/routes.ts, which
  // never computes a checklist live. Distinct from `loadError`: this isn't a failure, it's a
  // real, expected state the UI offers a next step for.
  const [needsPackFor, setNeedsPackFor] = useState<{ id: string; name: string } | null>(null);
  // Resolves well before `items`/`regionStats` — a count-only query with none of the full
  // list's reference-photo/tier joins or per-row mapping — so the header total updates on a
  // region/taxon switch without waiting for the (much heavier) species grid to load.
  const [quickCount, setQuickCount] = useState<{ total: number; collected: number } | null>(null);
  const [allRegions, setAllRegions] = useState<RegionSummary[]>([]);
  const [drillingDown, setDrillingDown] = useState(false);
  const [showStats, setShowStats] = useState(false);
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

  const load = useCallback(() => {
    setLoadError(false);
    const taxonQuery = taxonFilter === "all" ? "" : `taxon=${taxonFilter}`;
    // Only sent when relevant (see seaZonesRelevant's comment) — a stale seaZoneIds param
    // left in the URL from a previous "all taxa" view shouldn't silently reapply once the
    // taxon filter narrows to birds/mammals, since it would filter to zero without the
    // now-hidden checkboxes to explain why.
    const seaZoneQuery = seaZonesRelevant && seaZoneIds.length > 0 ? `seaZoneIds=${seaZoneIds.join(",")}` : "";
    const includeLandQuery = seaZoneQuery && !includeLand ? "includeLand=0" : "";

    setQuickCount(null);
    setNeedsPackFor(null);
    if (regionId && regionKnownHub) {
      // No scoped checklist to show — just the breadcrumb/children pills, already rendered
      // from `allRegions` below, need nothing fetched here.
      setItems(null);
      setRegionMeta(null);
      setRegionStats(null);
      setSeaZones([]);
    } else if (regionId) {
      api
        .get<{ total: number; collected: number }>(
          `/regions/${regionId}/species/count?${taxonQuery}&${seaZoneQuery}&${includeLandQuery}`,
        )
        .then(setQuickCount)
        .catch(() => {});
      api
        .get<RegionSpeciesResponse>(
          `/regions/${regionId}/species?filter=all&${taxonQuery}&${seaZoneQuery}&${includeLandQuery}`,
        )
        .then((res) => {
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
          collectionCache.set(collectionCacheKey(regionId, taxonFilter, seaZoneIds, includeLand), {
            items: res.items,
            regionMeta: res.region,
            regionStats: res.stats,
          });
        })
        .catch(() => setLoadError(true));
      api
        .get<{ zones: Array<{ id: string; name: string }> }>(`/regions/${regionId}/sea-zones`)
        .then((res) => setSeaZones(res.zones))
        .catch(() => setSeaZones([]));
    } else if (!firstRunPrompt) {
      setSeaZones([]);
      const query = taxonQuery ? `?${taxonQuery}` : "";
      api
        .get<{ total: number; collected: number }>(`/collection/count${query}`)
        .then(setQuickCount)
        .catch(() => {});
      api
        .get<{ items: CollectionItem[] }>(`/collection${query}`)
        .then((res) => {
          setItems(res.items);
          setRegionMeta(null);
          setRegionStats(null);
          collectionCache.set(collectionCacheKey(regionId, taxonFilter, seaZoneIds, includeLand), {
            items: res.items,
            regionMeta: null,
            regionStats: null,
          });
        })
        .catch(() => setLoadError(true));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seaZoneIds is an array; its
    // joined string is the real dependency (stable primitive, avoids reference-identity churn)
  }, [regionId, taxonFilter, seaZoneIds.join(","), includeLand, firstRunPrompt, regionKnownHub]);

  // Archived species are excluded server-side (see apps/api/src/species/obscurity.ts's
  // NOT_ARCHIVED_SQL) — after an archive action succeeds, the simplest correct way to reflect
  // that is just re-running the same fetch this page already does on every filter change,
  // rather than hand-patching `items`/`quickCount` in two places and risking them drifting
  // out of sync with what the server would actually return.
  const handleArchived = useCallback(() => load(), [load]);

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
    autoSelectedSeaZoneRegions.current.add(regionId);

    api
      .get<{ total: number }>(`/regions/${regionId}/species/count?taxon=actinopterygii`)
      .then((res) => {
        if (res.total === 0) updateParam("seaZones", seaZones.map((z) => z.id).join(","));
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seaZones is an array; length +
    // regionId together are the real dependency, same reasoning as seaZoneIds elsewhere here.
  }, [regionId, regionKnownHub, seaZonesRelevant, seaZones, seaZoneIds.length]);

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
  const children = useMemo(() => allRegions.filter((r) => r.parentId === regionId), [allRegions, regionId]);
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

  const visibleItems = useMemo(() => {
    if (!items) return null;
    let filtered = stateFilter === "all" ? items : items.filter((i) => i.state === stateFilter);
    const query = search.trim().toLowerCase();
    if (query) {
      filtered = filtered.filter(
        (i) => (i.commonName ?? "").toLowerCase().includes(query) || i.scientificName.toLowerCase().includes(query),
      );
    }
    return filtered;
  }, [items, stateFilter, search]);

  // Prefers the already-arrived full item list once it's in (it reflects any client-side
  // filtering nuance exactly), but falls back to the fast count-only fetch so the header
  // doesn't sit blank/stale while the heavier item list is still loading.
  const collectedCount = items ? items.filter((i) => i.state === "collected").length : (quickCount?.collected ?? 0);
  const totalCount = items ? items.length : (quickCount?.total ?? null);

  return (
    <div className="min-h-screen bg-canvas">
      <header className="page-header flex items-center justify-between border-b border-line bg-surface px-6 py-4">
        <div>
          <Logo variant="wordmark" className="h-7 w-auto" />
          {totalCount != null && (
            <p className="text-xs text-muted">
              {collectedCount} / {totalCount} collected
            </p>
          )}
        </div>
        <div className="flex items-center gap-4">
          <SpeciesPicker />
          <Link to="/import" className="text-sm text-muted hover:underline">
            Import
          </Link>
          <button onClick={() => setShowStats((s) => !s)} className="text-sm text-muted hover:underline">
            Stats
          </button>
          <Link to="/gallery" className="text-sm text-muted hover:underline">
            Gallery
          </Link>
          {isDesktopMode && (
            <Link to="/trips" className="text-sm text-muted hover:underline">
              Trips
            </Link>
          )}
          <Link to="/settings" className="text-sm text-muted hover:underline">
            Settings
          </Link>
          {!isDesktopMode && (
            <div className="flex items-center gap-3 text-sm text-muted">
              <span>{user?.email}</span>
              <button onClick={() => logout()} className="hover:underline">
                Log out
              </button>
            </div>
          )}
        </div>
      </header>

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
            </nav>
            {regionMeta && regionStats && (
              <div className="flex items-center gap-3">
                <div className="h-1.5 w-40 overflow-hidden rounded-full bg-surface-muted">
                  <div
                    className="h-full bg-ink"
                    style={{ width: `${regionStats.total ? Math.round((regionStats.collected / regionStats.total) * 100) : 0}%` }}
                  />
                </div>
                <p className="text-xs text-muted">
                  {regionStats.collected} collected · {regionStats.seen} seen · {regionStats.total} total
                </p>
                {regionMeta.ebirdRegionCode && (
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
            {(children.length > 0 || (regionMeta?.canDrillDown && !regionMeta.hasChildren)) && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs uppercase tracking-wide text-muted">Drill in:</span>
                {children.map((child) => (
                  <button
                    key={child.id}
                    onClick={() => navigateToRegion(child.id)}
                    className="rounded-full border border-line px-3 py-1 text-sm text-ink hover:bg-surface-muted"
                  >
                    {child.name}
                  </button>
                ))}
                {regionMeta?.canDrillDown && !regionMeta.hasChildren && (
                  <button
                    onClick={drillDown}
                    disabled={drillingDown}
                    className="rounded-full border border-line px-3 py-1 text-sm text-muted hover:bg-surface-muted disabled:opacity-50"
                  >
                    {drillingDown ? "Loading provinces/states…" : "Show provinces/states"}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-6 py-2 text-sm">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search this area…"
          className="w-48 rounded-md border border-line px-2 py-1 text-ink"
        />
        <label className="flex items-center gap-1.5 text-muted">
          Group
          <select
            value={groupBy}
            onChange={(e) => updateParam("group", e.target.value === "none" ? null : e.target.value)}
            className="rounded-md border border-line px-2 py-1 text-ink"
          >
            <option value="none">No grouping</option>
            <option value="group">Family group</option>
            <option value="tier">Rarity tier</option>
            {/* Only meaningful with a region selected — see the matching "Rarity here" sort
               option's own comment. */}
            {regionId && <option value="localTier">Rarity here</option>}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-muted">
          Sort
          <select
            value={sortBy}
            onChange={(e) => updateParam("sort", e.target.value === "taxonomic" ? null : e.target.value)}
            className="rounded-md border border-line px-2 py-1 text-ink"
          >
            <option value="taxonomic">Taxonomic</option>
            <option value="name">Name</option>
            <option value="rarity">Rarity</option>
            {/* Only meaningful with a region selected — localTier only comes back from
               GET /regions/:id/species, never plain GET /collection (see CollectionItem's
               own comment) — so this option would just silently do nothing without one. */}
            {regionId && <option value="localRarity">Rarity here</option>}
          </select>
        </label>
        <InfoTip paragraphs={RARITY_INFO_PARAGRAPHS} />
        <label className="flex items-center gap-1.5 text-muted">
          <input
            type="checkbox"
            checked={collectedFirst}
            onChange={(e) => updateParam("collectedFirst", e.target.checked ? null : "0")}
          />
          Collected first
        </label>
        <label className="flex items-center gap-1.5 text-muted">
          <input
            type="checkbox"
            checked={seenFirst}
            onChange={(e) => updateParam("seenFirst", e.target.checked ? "1" : null)}
          />
          Seen first
        </label>
        <label className="flex items-center gap-1.5 text-muted">
          Show
          <select
            value={stateFilter}
            onChange={(e) => updateParam("show", e.target.value === "all" ? null : e.target.value)}
            className="rounded-md border border-line px-2 py-1 text-ink"
          >
            <option value="all">All</option>
            <option value="collected">Collected</option>
            <option value="seen">Seen only</option>
            <option value="unseen">Not yet collected</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-muted">
          Taxon
          <select
            value={taxonFilter}
            onChange={(e) => updateParam("taxon", e.target.value === "all" ? null : e.target.value)}
            className="rounded-md border border-line px-2 py-1 text-ink"
          >
            {(Object.keys(TAXON_LABEL) as TaxonFilter[]).map((t) => (
              <option key={t} value={t}>
                {TAXON_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
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
        {showStats && <CollectionStatsPanel />}

        {regionId && regionMeta && <RegionMap boundaryGeoJson={regionMeta.boundaryGeoJson} regionKey={regionMeta.id} />}

        {firstRunPrompt ? (
          <div className="rounded-xl border border-line bg-surface p-8 text-center">
            <h2 className="text-lg font-semibold text-ink">Welcome to Lifer</h2>
            <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
              Pick a region to see its checklist and start tracking what you've photographed there.
            </p>
            <div className="mt-4 flex items-center justify-center gap-4">
              {worldRegion && (
                <button
                  onClick={() => navigateToRegion(worldRegion.id)}
                  className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg"
                >
                  Browse by region
                </button>
              )}
              <button onClick={() => setFirstRunPrompt(false)} className="text-sm text-muted hover:underline">
                Or view every species worldwide
              </button>
            </div>
          </div>
        ) : regionKnownHub ? (
          <p className="text-muted">Pick a region above to see its checklist.</p>
        ) : needsPackFor ? (
          <NeedsPackPrompt region={needsPackFor} onDownloaded={load} />
        ) : loadError ? (
          <p className="text-muted">
            Couldn't load this view.{" "}
            <button onClick={load} className="text-ink underline">
              Retry
            </button>
          </p>
        ) : !visibleItems ? (
          <Spinner />
        ) : visibleItems.length === 0 ? (
          <p className="text-muted">Nothing matches that filter.</p>
        ) : (
          <GroupedSpeciesGrid
            items={visibleItems}
            regionId={regionId ?? undefined}
            groupBy={groupBy}
            sortBy={sortBy}
            collectedFirst={collectedFirst}
            seenFirst={seenFirst}
            onArchived={handleArchived}
          />
        )}
      </main>
    </div>
  );
}

interface OfflinePackEntry {
  id: string;
  type: "region" | "seaZone";
  region?: string;
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
          <Link to="/offline-packs" className="underline">
            Offline packs
          </Link>{" "}
          later, or ask whoever runs this Lifer instance about it.
        </p>
      ) : (
        <>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
            {pack.speciesCount} species, {(pack.sizeBytes / 1024 / 1024).toFixed(0)}MB.
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
