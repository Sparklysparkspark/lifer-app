import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { CollectionItem, RegionSpeciesResponse, RegionSummary } from "@lifer/shared";
import { api } from "../api/client";
import { useAuth } from "../hooks/useAuth";
import { useDesktopMode } from "../hooks/useDesktopMode";
import SpeciesPicker from "../components/SpeciesPicker";
import CollectionStatsPanel from "../components/CollectionStats";
import GroupedSpeciesGrid, { type GroupBy, type SortBy } from "../components/GroupedSpeciesGrid";
import EbirdImport from "../components/EbirdImport";
import RegionMap from "../components/RegionMap";

type StateFilter = "all" | "collected" | "seen" | "unseen";
type TaxonFilter = "all" | "aves" | "mammalia" | "actinopterygii";

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
  // "Collected first" (everything shown, collected species pinned at top) defaults on; this
  // is distinct from the "Show: Collected only" filter (which defaults to "All" below). No
  // `collectedFirst` param at all means checked; explicitly unchecking writes
  // `collectedFirst=0` into the URL so it's distinguishable from the default.
  const collectedFirst = searchParams.get("collectedFirst") !== "0";
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
    updateParam("seaZones", next.length > 0 ? next.join(",") : null);
    // Clearing the last zone makes "include land" meaningless again — drop it so a later
    // zone pick doesn't silently inherit a stale "land off" from an unrelated earlier zone.
    if (next.length === 0) updateParam("includeLand", null);
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

  function updateParam(key: string, value: string | null) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
      return next;
    });
  }

  const [items, setItems] = useState<CollectionItem[] | null>(null);
  const [regionMeta, setRegionMeta] = useState<RegionSpeciesResponse["region"] | null>(null);
  const [regionStats, setRegionStats] = useState<RegionSpeciesResponse["stats"] | null>(null);
  const [allRegions, setAllRegions] = useState<RegionSummary[]>([]);
  const [drillingDown, setDrillingDown] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // In-view search filters whatever's already on screen (all species, or the current
  // region's checklist), not a separate global lookup like the header's SpeciesPicker (which
  // navigates away). Deliberately plain component state, not a URL param, and reset on
  // region change — a filter scoped to the current view shouldn't carry over when drilling
  // into a different region.
  const [search, setSearch] = useState("");
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

    if (regionId && regionKnownHub) {
      // No scoped checklist to show — just the breadcrumb/children pills, already rendered
      // from `allRegions` below, need nothing fetched here.
      setItems(null);
      setRegionMeta(null);
      setRegionStats(null);
      setSeaZones([]);
    } else if (regionId) {
      api
        .get<RegionSpeciesResponse>(
          `/regions/${regionId}/species?filter=all&${taxonQuery}&${seaZoneQuery}&${includeLandQuery}`,
        )
        .then((res) => {
          setItems(res.items);
          setRegionMeta(res.region);
          setRegionStats(res.stats);
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
        .get<{ items: CollectionItem[] }>(`/collection${query}`)
        .then((res) => {
          setItems(res.items);
          setRegionMeta(null);
          setRegionStats(null);
        })
        .catch(() => setLoadError(true));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seaZoneIds is an array; its
    // joined string is the real dependency (stable primitive, avoids reference-identity churn)
  }, [regionId, taxonFilter, seaZoneIds.join(","), includeLand, firstRunPrompt, regionKnownHub]);

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

  useEffect(() => {
    if (!regionResolved || !regionsLoaded) return;
    load();
  }, [load, regionResolved, regionsLoaded]);

  const prevRegionId = useRef(regionId);
  useEffect(() => {
    setSearch("");
    // A sea zone picked for one region (e.g. Egypt -> Red Sea) is meaningless for a
    // different region — cleared when the region actually changes, but NOT on first mount
    // (a bookmarked/shared `?region=X&seaZone=Y` URL should still work when opened fresh).
    if (prevRegionId.current !== regionId) updateParam("seaZones", null);
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

  const collectedCount = items?.filter((i) => i.state === "collected").length ?? 0;

  return (
    <div className="min-h-screen bg-stone-50">
      <header className="flex items-center justify-between border-b border-stone-200 bg-white px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold text-stone-900">Lifer</h1>
          {items && (
            <p className="text-xs text-stone-500">
              {collectedCount} / {items.length} collected
            </p>
          )}
        </div>
        <div className="flex items-center gap-4">
          <SpeciesPicker />
          <Link to="/import" className="text-sm text-stone-500 hover:underline">
            Import
          </Link>
          <button onClick={() => setShowStats((s) => !s)} className="text-sm text-stone-500 hover:underline">
            Stats
          </button>
          <Link to="/gallery" className="text-sm text-stone-500 hover:underline">
            Gallery
          </Link>
          <Link to="/offline-packs" className="text-sm text-stone-500 hover:underline">
            Offline packs
          </Link>
          <Link to="/settings" className="text-sm text-stone-500 hover:underline">
            Settings
          </Link>
          {!isDesktopMode && (
            <div className="flex items-center gap-3 text-sm text-stone-500">
              <span>{user?.email}</span>
              <button onClick={() => logout()} className="hover:underline">
                Log out
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Region breadcrumb — the main-screen drill-down entry point. */}
      <div className="border-b border-stone-200 bg-white px-6 py-2">
        {!regionId ? (
          worldRegion && (
            <button onClick={() => navigateToRegion(worldRegion.id)} className="text-sm text-stone-500 hover:underline">
              Browse by region →
            </button>
          )
        ) : (
          <div className="space-y-2">
            <nav className="flex flex-wrap items-center gap-1 text-sm text-stone-500">
              <button onClick={() => navigateToRegion(null)} className="hover:underline">
                All species
              </button>
              {breadcrumb.map((r, i) => (
                <span key={r.id} className="flex items-center gap-1">
                  <span className="text-stone-300">/</span>
                  {i === breadcrumb.length - 1 ? (
                    <span className="font-medium text-stone-900">{r.name}</span>
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
                <div className="h-1.5 w-40 overflow-hidden rounded-full bg-stone-100">
                  <div
                    className="h-full bg-stone-900"
                    style={{ width: `${regionStats.total ? Math.round((regionStats.collected / regionStats.total) * 100) : 0}%` }}
                  />
                </div>
                <p className="text-xs text-stone-500">
                  {regionStats.collected} collected · {regionStats.seen} seen · {regionStats.total} total
                </p>
                {regionMeta.ebirdRegionCode && (
                  <a
                    href={`https://ebird.org/region/${regionMeta.ebirdRegionCode}/illustrated-checklist`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-stone-500 hover:underline"
                  >
                    eBird Illustrated Checklist ↗
                  </a>
                )}
              </div>
            )}
            {(children.length > 0 || (regionMeta?.canDrillDown && !regionMeta.hasChildren)) && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs uppercase tracking-wide text-stone-400">Drill in:</span>
                {children.map((child) => (
                  <button
                    key={child.id}
                    onClick={() => navigateToRegion(child.id)}
                    className="rounded-full border border-stone-300 px-3 py-1 text-sm text-stone-700 hover:bg-stone-100"
                  >
                    {child.name}
                  </button>
                ))}
                {regionMeta?.canDrillDown && !regionMeta.hasChildren && (
                  <button
                    onClick={drillDown}
                    disabled={drillingDown}
                    className="rounded-full border border-stone-300 px-3 py-1 text-sm text-stone-500 hover:bg-stone-100 disabled:opacity-50"
                  >
                    {drillingDown ? "Loading provinces/states…" : "Show provinces/states"}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-b border-stone-200 bg-white px-6 py-2 text-sm">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search this view…"
          className="w-48 rounded-md border border-stone-300 px-2 py-1 text-stone-700"
        />
        {search && (
          <button onClick={() => setSearch("")} className="text-stone-400 hover:text-stone-600" aria-label="Clear search">
            ✕
          </button>
        )}
        <label className="flex items-center gap-1.5 text-stone-500">
          Group
          <select
            value={groupBy}
            onChange={(e) => updateParam("group", e.target.value === "none" ? null : e.target.value)}
            className="rounded-md border border-stone-300 px-2 py-1 text-stone-700"
          >
            <option value="none">No grouping</option>
            <option value="group">Family group</option>
            <option value="tier">Rarity tier</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-stone-500">
          Sort
          <select
            value={sortBy}
            onChange={(e) => updateParam("sort", e.target.value === "taxonomic" ? null : e.target.value)}
            className="rounded-md border border-stone-300 px-2 py-1 text-stone-700"
          >
            <option value="taxonomic">Taxonomic</option>
            <option value="name">Name</option>
            <option value="rarity">Rarity</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-stone-500">
          <input
            type="checkbox"
            checked={collectedFirst}
            onChange={(e) => updateParam("collectedFirst", e.target.checked ? null : "0")}
          />
          Collected first
        </label>
        <label className="flex items-center gap-1.5 text-stone-500">
          Show
          <select
            value={stateFilter}
            onChange={(e) => updateParam("show", e.target.value === "all" ? null : e.target.value)}
            className="rounded-md border border-stone-300 px-2 py-1 text-stone-700"
          >
            <option value="all">All</option>
            <option value="collected">Collected</option>
            <option value="seen">Seen only</option>
            <option value="unseen">Not yet collected</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-stone-500">
          Taxon
          <select
            value={taxonFilter}
            onChange={(e) => updateParam("taxon", e.target.value === "all" ? null : e.target.value)}
            className="rounded-md border border-stone-300 px-2 py-1 text-stone-700"
          >
            {(Object.keys(TAXON_LABEL) as TaxonFilter[]).map((t) => (
              <option key={t} value={t}>
                {TAXON_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        {seaZonesRelevant && seaZones.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-stone-500">
            <span>Include nearby water:</span>
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
              <label className="flex items-center gap-1 border-l border-stone-300 pl-2">
                <input type="checkbox" checked={includeLand} onChange={(e) => setIncludeLand(e.target.checked)} />
                Include {regionMeta?.name ?? "region"}'s own species
              </label>
            )}
          </div>
        )}
      </div>

      <main className="space-y-6 p-6">
        {showStats && <CollectionStatsPanel />}

        {regionId && regionMeta && (
          <>
            <RegionMap boundaryGeoJson={regionMeta.boundaryGeoJson} />
            <EbirdImport onImported={load} />
          </>
        )}

        {firstRunPrompt ? (
          <div className="rounded-xl border border-stone-200 bg-white p-8 text-center">
            <h2 className="text-lg font-semibold text-stone-900">Welcome to Lifer</h2>
            <p className="mx-auto mt-2 max-w-sm text-sm text-stone-500">
              Pick a region to see its checklist and start tracking what you've photographed there.
            </p>
            <div className="mt-4 flex items-center justify-center gap-4">
              {worldRegion && (
                <button
                  onClick={() => navigateToRegion(worldRegion.id)}
                  className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white"
                >
                  Browse by region
                </button>
              )}
              <button onClick={() => setFirstRunPrompt(false)} className="text-sm text-stone-500 hover:underline">
                Or view every species worldwide
              </button>
            </div>
          </div>
        ) : regionKnownHub ? (
          <p className="text-stone-500">Pick a region above to see its checklist.</p>
        ) : loadError ? (
          <p className="text-stone-500">
            Couldn't load this view.{" "}
            <button onClick={load} className="text-stone-900 underline">
              Retry
            </button>
          </p>
        ) : !visibleItems ? (
          <p className="text-stone-500">Loading…</p>
        ) : visibleItems.length === 0 ? (
          <p className="text-stone-500">Nothing matches that filter.</p>
        ) : (
          <GroupedSpeciesGrid
            items={visibleItems}
            regionId={regionId ?? undefined}
            groupBy={groupBy}
            sortBy={sortBy}
            collectedFirst={collectedFirst}
          />
        )}
      </main>
    </div>
  );
}
