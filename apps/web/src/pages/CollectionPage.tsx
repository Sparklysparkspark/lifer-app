import { useCallback, useDeferredValue, useMemo, useTransition, lazy, Suspense } from "react";
import { Link } from "react-router-dom";
import GroupedSpeciesGrid from "../components/GroupedSpeciesGrid";
import type { SpeciesChange } from "../components/SpeciesCard";
import { useMapAvailable } from "../hooks/useMapAvailable";
import { useSettings } from "../hooks/useSettings";
import { Spinner } from "../components/LoadingScreen";
import EmptyState from "../components/EmptyState";
import { useNavCounts } from "../components/AppNav";
import { useCollectionUrlState } from "./collection/useCollectionUrlState";
import { useCollectionDisplayPrefs } from "./collection/useCollectionDisplayPrefs";
import { useRegionTree } from "./collection/useRegionTree";
import { useTaxonAvailability } from "./collection/useTaxonAvailability";
import { useCollectionData } from "./collection/useCollectionData";
import { seaZonesRelevantFor, useSeaZoneFilter } from "./collection/useSeaZoneFilter";
import { useFirstRunRegion } from "./collection/useFirstRunRegion";
import { filterCollectionItems, searchHaystack } from "./collection/filterItems";
import RegionBreadcrumb from "./collection/RegionBreadcrumb";
import CollectionToolbar from "./collection/CollectionToolbar";
import { NeedsPackPrompt, TaxonPackPrompt } from "./collection/PackPrompts";

// maplibre is large, so the map loads on demand instead of with the startup bundle.
const RegionMap = lazy(() => import("../components/RegionMap"));

const MAP_PLACEHOLDER = <div className="h-80 w-full rounded-lg border border-line bg-surface-muted" />;

const ALERT_ICON = (
  <svg viewBox="0 0 24 24" className="h-6 w-6 text-muted" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v5M12 16h.01" />
  </svg>
);

const SEARCH_ICON = (
  <svg viewBox="0 0 24 24" className="h-6 w-6 text-muted" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

// The main screen: everything collected, or one region's checklist, with the region picked
// from the breadcrumb. `?region=` is a real URL param so a drilled-in view is bookmarkable.
export default function CollectionPage() {
  const url = useCollectionUrlState();
  const { regionId, taxonFilters, singleTaxonFilter, seaZoneIds, includeLand, updateParam, updateParams } = url;
  const prefs = useCollectionDisplayPrefs();
  const mapAvailable = useMapAvailable();
  const { settings } = useSettings();
  const namingStyles = useMemo(() => settings?.speciesNamingStyles ?? [], [settings?.speciesNamingStyles]);
  const [isGroupingPending, startGroupingTransition] = useTransition();

  const tree = useRegionTree(regionId);
  const setRegionParam = useCallback((id: string | null) => updateParam("region", id), [updateParam]);
  const { firstRunPrompt, regionResolved, navigateToRegion } = useFirstRunRegion({
    regionId,
    setRegionParam,
    regionsLoaded: tree.regionsLoaded,
    allRegions: tree.allRegions,
    downloadedCountryNames: tree.downloadedCountryNames,
  });

  const taxa = useTaxonAvailability({
    regionId,
    regionKnownHub: tree.regionKnownHub,
    taxonFilters,
    isTaxonPackDownloaded: tree.isTaxonPackDownloaded,
    downloadedRegionTaxons: tree.downloadedRegionTaxons,
  });

  const packsKnown = tree.downloadedRegionTaxons !== null;
  const seaZonesRelevant = seaZonesRelevantFor(taxonFilters, regionId, tree.isTaxonPackDownloaded);
  const data = useCollectionData({
    regionId,
    taxonRaw: url.taxonRaw,
    singleTaxonFilter,
    seaZoneIds,
    includeLand,
    seaZonesRelevant,
    regionKnownHub: tree.regionKnownHub,
    firstRunPrompt,
    // A restored ?seaZones= waits for the pack index so relevance is known before the fetch.
    ready: regionResolved && tree.regionsLoaded && (seaZoneIds.length === 0 || !regionId || packsKnown),
  });
  const { items, regionMeta, regionStats } = data;

  const seaZoneActions = useSeaZoneFilter({
    regionId,
    regionKnownHub: tree.regionKnownHub,
    seaZonesRelevant,
    packsKnown,
    seaZoneIds,
    seaZones: data.seaZones,
    isTaxonPackDownloaded: tree.isTaxonPackDownloaded,
    updateParams,
  });

  // Removing the last species of an Other Taxa group should also drop that group's filter.
  const { applyChange, load } = data;
  const { reloadTaxaPresent } = taxa;
  const handleSpeciesChanged = useCallback(
    (speciesIds: string | string[], change: SpeciesChange) => {
      applyChange(speciesIds, change);
      if (change === "removed") reloadTaxaPresent();
    },
    [applyChange, reloadTaxaPresent],
  );

  // A pack downloaded from a prompt changes which taxa are unlocked, not only the list.
  const { loadDownloadedPacks } = tree;
  const handlePackDownloaded = useCallback(() => {
    load();
    loadDownloadedPacks();
    reloadTaxaPresent();
  }, [load, loadDownloadedPacks, reloadTaxaPresent]);

  const { regionsError, refreshRegions } = tree;
  const retry = useCallback(() => {
    if (regionsError) void refreshRegions().catch(() => {});
    load();
  }, [regionsError, refreshRegions, load]);

  const hasGhost = items ? items.some((i) => i.isGhost) : false;
  const hasLost = items ? items.some((i) => i.isLost) : false;
  // Newest first: "how many so far this year" is the usual question.
  const availableYears = useMemo(() => {
    if (!items) return [];
    const years = new Set<number>();
    for (const i of items) for (const y of i.capturedYears ?? []) years.add(y);
    return [...years].sort((a, b) => b - a);
  }, [items]);

  // Normalized names built once per list, and the search deferred so typing stays responsive
  // on a 60k-row list.
  const haystacks = useMemo(() => new Map((items ?? []).map((i) => [i.speciesId, searchHaystack(i)])), [items]);
  const deferredSearch = useDeferredValue(url.search);
  const { stateFilter, ghostOnly, lostOnly, likelyThisMonthOnly, yearFilter } = url;
  const visibleItems = useMemo(
    () =>
      items
        ? filterCollectionItems(items, { stateFilter, ghostOnly, lostOnly, likelyThisMonthOnly, yearFilter, search: deferredSearch }, haystacks)
        : null,
    [items, stateFilter, ghostOnly, lostOnly, likelyThisMonthOnly, yearFilter, deferredSearch, haystacks],
  );
  // What's being viewed, not how many times it loaded: the cached list, then the fresh one, then an
  // upload's reload all keep the cards already showing.
  const gridResetKey = [data.listKey, stateFilter, ghostOnly, lostOnly, likelyThisMonthOnly, yearFilter, deferredSearch].join("|");

  // The full list once it's in, the fast count until then.
  const collectedCount = items ? items.filter((i) => i.state === "collected").length : (data.quickCount?.collected ?? 0);
  const totalCount = items ? items.length : (data.quickCount?.total ?? null);
  useNavCounts(collectedCount, totalCount);

  // Hubs have no server stats, so their bar is computed from the aggregated items.
  const hubStats = useMemo(() => {
    if (!tree.regionKnownHub || !items) return null;
    let collected = 0;
    let seen = 0;
    for (const i of items) {
      if (i.state === "collected") collected++;
      else if (i.state === "seen") seen++;
    }
    return { collected, seen, total: items.length };
  }, [tree.regionKnownHub, items]);

  const showMapToggle = !!regionMeta && !tree.regionKnownHub && !!regionMeta.boundaryGeoJson && !!mapAvailable;

  return (
    <div className="flex-1 bg-canvas">
      <RegionBreadcrumb
        regionId={regionId}
        worldRegion={tree.worldRegion}
        downloadedCountries={tree.downloadedCountries}
        breadcrumb={tree.breadcrumb}
        navigateToRegion={navigateToRegion}
        regionMeta={regionMeta}
        regionStats={regionStats}
        regionKnownHub={tree.regionKnownHub}
        hubStats={hubStats}
        showEbirdLink={taxonFilters.size === 0 || taxonFilters.has("aves")}
        mapToggle={showMapToggle ? { collapsed: prefs.mapCollapsed, onToggle: prefs.toggleMapCollapsed } : null}
        childRegions={tree.children}
        allChildren={tree.allChildren}
        availableRegionIds={tree.availableRegionIds}
        onDrilledDown={() => {
          void refreshRegions().catch(() => {});
          load();
        }}
      />

      <CollectionToolbar
        url={url}
        prefs={prefs}
        startTransition={startGroupingTransition}
        availableTaxonFilters={taxa.availableTaxonFilters}
        namingStyles={namingStyles}
        availableYears={availableYears}
        hasGhost={hasGhost}
        hasLost={hasLost}
        shownCount={visibleItems?.length ?? null}
        totalLoaded={items?.length ?? null}
        seaZones={data.seaZones}
        seaZonesRelevant={seaZonesRelevant}
        regionName={regionMeta?.name}
        onToggleSeaZone={seaZoneActions.toggleSeaZone}
        onSetAllSeaZones={seaZoneActions.setAllSeaZones}
        onSetIncludeLand={seaZoneActions.setIncludeLand}
      />

      <main className="space-y-6 p-6">
        {regionId && regionMeta && !!regionMeta.boundaryGeoJson && mapAvailable && !prefs.mapCollapsed && (
          <Suspense fallback={MAP_PLACEHOLDER}>
            <RegionMap boundaryGeoJson={regionMeta.boundaryGeoJson} regionKey={regionMeta.id} />
          </Suspense>
        )}

        {firstRunPrompt ? (
          <div className="rounded-xl border border-line bg-surface p-8 text-center">
            <h2 className="text-lg font-semibold text-ink">Welcome to Lifer</h2>
            <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
              Download a region's offline pack to see its checklist and start tracking what you've photographed there.
            </p>
            <div className="mt-4 flex items-center justify-center gap-4">
              <Link to="/offline-packs" state={{ backLabel: "Collection" }} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg">
                Download a pack
              </Link>
            </div>
          </div>
        ) : tree.regionKnownHub && items && items.length === 0 && data.downloadedHubCountryNames.length === 0 ? (
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
        ) : data.needsPackFor ? (
          <NeedsPackPrompt region={data.needsPackFor} onDownloaded={handlePackDownloaded} />
        ) : data.loadError ? (
          <EmptyState
            icon={ALERT_ICON}
            title="Couldn't load this view"
            description="Something went wrong fetching your collection. Try again."
            action={{ label: "Retry", onClick: retry }}
          />
        ) : !visibleItems ? (
          <Spinner />
        ) : data.taxonPackMissingFor &&
          data.taxonPackMissingFor.id === regionId &&
          data.taxonPackMissingFor.taxon === singleTaxonFilter &&
          visibleItems.length === 0 ? (
          <TaxonPackPrompt
            regionId={data.taxonPackMissingFor.id}
            regionName={data.taxonPackMissingFor.name}
            taxon={data.taxonPackMissingFor.taxon}
            onDownloaded={handlePackDownloaded}
          />
        ) : visibleItems.length === 0 ? (
          <EmptyState icon={SEARCH_ICON} title="Nothing matches that filter" description="Try a different search, or loosen the filters." />
        ) : (
          <div className={isGroupingPending || deferredSearch !== url.search ? "opacity-60 transition-opacity" : "transition-opacity"}>
            {/* Only photographed species show without the taxon's pack; offer the rest. */}
            {data.taxonPackMissingFor && data.taxonPackMissingFor.id === regionId && data.taxonPackMissingFor.taxon === singleTaxonFilter && (
              <TaxonPackPrompt
                regionId={data.taxonPackMissingFor.id}
                regionName={data.taxonPackMissingFor.name}
                taxon={data.taxonPackMissingFor.taxon}
                onDownloaded={handlePackDownloaded}
                photographed={visibleItems.filter((i) => i.state === "collected" || i.state === "seen").length}
              />
            )}
            <GroupedSpeciesGrid
              items={visibleItems}
              resetKey={gridResetKey}
              regionId={regionId ?? undefined}
              groupBy={url.groupBy}
              sortBy={url.sortBy}
              collectedFirst={url.collectedFirst}
              seenFirst={url.seenFirst}
              targetFirst={url.targetFirst}
              onChanged={handleSpeciesChanged}
              cardMinWidth={prefs.cardMinWidth}
              regionName={regionMeta?.name}
              countryRegionId={tree.countryAncestor?.id}
              countryRegionName={tree.countryAncestor?.name}
              hideLabels={prefs.hideLabels}
              hideNames={prefs.hideNames}
              hideScientificName={prefs.hideScientificName}
            />
          </div>
        )}
      </main>
    </div>
  );
}
