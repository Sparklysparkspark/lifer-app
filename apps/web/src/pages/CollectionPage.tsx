import { useCallback, useDeferredValue, useEffect, useMemo, useState, useTransition, lazy, Suspense } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, Navigate } from "react-router-dom";
import GroupedSpeciesGrid from "../components/GroupedSpeciesGrid";
import type { SpeciesChange } from "../components/SpeciesCard";
import { useMapAvailable } from "../hooks/useMapAvailable";
import { useDeploymentMode } from "../hooks/useDeploymentMode";
import { useSettings } from "../hooks/useSettings";
import { Spinner } from "../components/LoadingScreen";
import EmptyState from "../components/EmptyState";
import { useCollectionUrlState } from "./collection/useCollectionUrlState";
import { useCollectionDisplayPrefs } from "./collection/useCollectionDisplayPrefs";
import { useRegionTree } from "./collection/useRegionTree";
import { useTaxonAvailability } from "./collection/useTaxonAvailability";
import { useCollectionData } from "./collection/useCollectionData";
import { seaZonesRelevantFor, useSeaZoneFilter } from "./collection/useSeaZoneFilter";
import { useNearbySeaZones } from "./collection/useNearbySeaZones";
import { startsOnboarding, useFirstRunRegion } from "./collection/useFirstRunRegion";
import { usePackDownloadStatus } from "../hooks/usePackDownloadStatus";
import { filterCollectionItems, searchHaystack, searchRanks } from "./collection/filterItems";
import RegionBreadcrumb from "./collection/RegionBreadcrumb";
import CollectionSelectBar from "./collection/CollectionSelectBar";
import CollectionToolbar from "./collection/CollectionToolbar";
import { NeedsPackPrompt, TaxonPackPrompt } from "./collection/PackPrompts";
import { isOtherTaxaFilter } from "./collection/taxonLabels";
import { useScrollMemory } from "../hooks/useScrollMemory";
import { useReadyMarker } from "../lib/readyMarker";
import { ignore } from "../lib/ignore";
import { shortcutLabel } from "../lib/keymap";
import Panel from "../components/Panel";
import Tip from "../components/Tip";
import { buttonClasses } from "../lib/buttonClasses";
import { countriesInView, useHubBoundary } from "./collection/useHubBoundary";
import { SPECIES_DOWNLOADS_PATH } from "../lib/speciesDownloads";
import { regionListsFirst, useTargetLists } from "../lib/targetLists";

// maplibre is large, so the map loads on demand instead of with the startup bundle.
const RegionMap = lazy(() => import("../components/RegionMap"));

const MAP_PLACEHOLDER = <div className="h-80 w-full rounded-panel border border-line bg-surface-muted" />;

const ALERT_ICON = (
  <svg
    viewBox="0 0 24 24"
    className="h-6 w-6 text-muted"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v5M12 16h.01" />
  </svg>
);

const SEARCH_ICON = (
  <svg
    viewBox="0 0 24 24"
    className="h-6 w-6 text-muted"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

// The main screen: everything collected, or one region's checklist, with the region picked
// from the breadcrumb. `?region=` is a real URL param so a drilled-in view is bookmarkable.
export default function CollectionPage() {
  const { t } = useTranslation();
  const url = useCollectionUrlState();
  const { regionId, taxonFilters, singleTaxonFilter, seaZoneIds, includeLand, updateParam, updateParams } = url;
  const prefs = useCollectionDisplayPrefs();
  // The grid's measured width, so the Size slider can offer only sizes that change the layout.
  const [gridWidth, setGridWidth] = useState<number | null>(null);
  const mapAvailable = useMapAvailable();
  const { settings } = useSettings();
  const namingStyles = useMemo(() => settings?.speciesNamingStyles ?? [], [settings?.speciesNamingStyles]);
  const [isGroupingPending, startGroupingTransition] = useTransition();

  // Downloaded countries a hub's answer named (read from this computer): the tree's stand-in if
  // the pack list fails, so it never offers countries that aren't downloaded.
  const [namedCountries, setNamedCountries] = useState<string[]>([]);
  const tree = useRegionTree(regionId, namedCountries);
  const setRegionParam = useCallback(
    (id: string | null, options?: { replace?: boolean }) => updateParam("region", id, options),
    [updateParam],
  );
  const { firstRunPrompt, regionResolved, navigateToRegion } = useFirstRunRegion({
    regionId,
    setRegionParam,
    regionsLoaded: tree.regionsLoaded,
    allRegions: tree.allRegions,
    downloadedCountryNames: tree.downloadedCountryNames,
  });
  // A deep link or stored region naming a group with one province shows that province's page.
  useEffect(() => {
    if (tree.landingId !== regionId) setRegionParam(tree.landingId, { replace: true });
  }, [tree.landingId, regionId, setRegionParam]);
  // The desktop app has no account step, which is where onboarding (map, species matching, a
  // first pack) otherwise starts, so its first run starts it here instead.
  const deploymentMode = useDeploymentMode();
  // No pack at all means nothing to show whatever region was remembered (a fresh install can
  // still hold the old one in browser storage), so setup wins over an empty filter view.
  const packDownload = usePackDownloadStatus();
  const desktopFirstRun = startsOnboarding({
    desktop: deploymentMode === "desktop",
    packCount: tree.regionsLoaded ? (tree.downloadedCountryNames?.size ?? null) : null,
    packsError: tree.packsError != null,
    downloadRunning: packDownload?.running ?? null,
  });

  const taxa = useTaxonAvailability({
    regionId,
    regionKnownHub: tree.regionKnownHub,
    taxonFilters,
    isTaxonPackDownloaded: tree.isTaxonPackDownloaded,
    downloadedRegionTaxons: tree.downloadedRegionTaxons,
  });

  const nearbySeaZones = useNearbySeaZones(regionId, tree.regionKnownHub);
  // Sea zone relevance needs both the pack index and the region's zones.
  const packsKnown = tree.downloadedRegionTaxons !== null && nearbySeaZones.known;
  // A zone you added species to yourself is offered whatever the filter or packs.
  const seaZonesRelevant =
    seaZonesRelevantFor(taxonFilters, regionId, tree.isTaxonPackDownloaded) ||
    nearbySeaZones.zones.some((z) => z.addedByYou > 0);
  const data = useCollectionData({
    regionId,
    taxonRaw: url.taxonRaw,
    singleTaxonFilter,
    seaZoneIds,
    includeLand,
    seaZonesRelevant,
    regionKnownHub: tree.regionKnownHub,
    firstRunPrompt,
    photographedIn: prefs.photographedIn,
    // A restored ?seaZones= waits for the pack index so relevance is known before the fetch.
    ready: regionResolved && tree.regionsLoaded && (seaZoneIds.length === 0 || !regionId || packsKnown),
  });
  const newlyNamed = data.downloadedHubCountryNames.filter((n) => !namedCountries.includes(n));
  if (newlyNamed.length > 0) setNamedCountries([...namedCountries, ...newlyNamed]);
  const { items, regionMeta, regionStats } = data;

  const seaZoneActions = useSeaZoneFilter({
    regionId,
    regionKnownHub: tree.regionKnownHub,
    seaZonesRelevant,
    packsKnown,
    seaZoneIds,
    seaZones: nearbySeaZones.zones,
    isTaxonPackDownloaded: tree.isTaxonPackDownloaded,
    updateParams,
  });

  // Removing the last species of an Other Taxa group should also drop that group's filter.
  // A reload can follow removing a species you added to a sea zone, which changes which zones
  // are offered.
  const { applyChange, load } = data;
  const { reloadTaxaPresent } = taxa;
  const reloadSeaZones = nearbySeaZones.reload;
  const handleSpeciesChanged = useCallback(
    (speciesIds: string | string[], change: SpeciesChange) => {
      applyChange(speciesIds, change);
      if (change === "removed") reloadTaxaPresent();
      if (change === "reload") reloadSeaZones();
    },
    [applyChange, reloadTaxaPresent, reloadSeaZones],
  );
  const handleChecklistChanged = useCallback(() => {
    load();
    reloadTaxaPresent();
    reloadSeaZones();
  }, [load, reloadTaxaPresent, reloadSeaZones]);
  const selectedSeaZones = useMemo(
    () => (seaZonesRelevant ? nearbySeaZones.zones.filter((z) => seaZoneIds.includes(z.id)) : []),
    [seaZonesRelevant, nearbySeaZones.zones, seaZoneIds],
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
    if (regionsError) void refreshRegions().catch(ignore("Couldn't reload the region list"));
    load();
  }, [regionsError, refreshRegions, load]);

  const hasGhost = items ? items.some((i) => i.isGhost) : false;
  const hasLost = items ? items.some((i) => i.isLost) : false;
  const hasNeedsBetter = items ? items.some((i) => i.needsBetterPhoto) : false;
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
  const { itemFilters } = url;
  const targetLists = useTargetLists();
  const targetListIds = targetLists?.find((l) => l.id === url.targetListId)?.speciesIds;
  const targetListSpecies = useMemo(() => (targetListIds ? new Set(targetListIds) : null), [targetListIds]);
  const visibleItems = useMemo(
    () =>
      items
        ? filterCollectionItems(items, { ...itemFilters, search: deferredSearch, targetListSpecies }, haystacks)
        : null,
    [items, itemFilters, deferredSearch, haystacks, targetListSpecies],
  );
  // Scores only the species already found, once per search.
  const searchRanked = useMemo(
    () => (visibleItems ? searchRanks(visibleItems, deferredSearch, haystacks) : null),
    [visibleItems, deferredSearch, haystacks],
  );
  // Select mode: the set only ever holds species still on screen, so a filter change can't leave
  // hidden species in a bulk action.
  const [selectMode, setSelectMode] = useState(false);
  const [pickedIds, setPickedIds] = useState<ReadonlySet<string>>(new Set());
  const selectedIds = useMemo(() => {
    if (!visibleItems || pickedIds.size === 0) return pickedIds;
    const onScreen = new Set(visibleItems.map((i) => i.speciesId));
    return new Set([...pickedIds].filter((id) => onScreen.has(id)));
  }, [visibleItems, pickedIds]);
  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setPickedIds(new Set());
  }, []);
  const changePicked = useCallback((ids: string[], on: boolean) => {
    setPickedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);
  const gridSelection = useMemo(
    () => (selectMode ? { selected: selectedIds, onChange: changePicked } : undefined),
    [selectMode, selectedIds, changePicked],
  );
  // Back from a species page returns to the same spot in the list, once it has loaded.
  useScrollMemory(!!visibleItems && visibleItems.length > 0);
  useReadyMarker(visibleItems !== null);
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

  // A continent or the world shows the downloaded countries in it (useHubBoundary).
  const hubBoundary = useHubBoundary(regionId, tree.regionKnownHub, tree.worldRegion?.id, tree.downloadedCountries);
  const groupCountries = useMemo(
    () =>
      countriesInView(
        regionId,
        tree.regionKnownHub,
        tree.worldRegion?.id,
        tree.downloadedCountries,
        tree.countryAncestor,
      ),
    [regionId, tree.regionKnownHub, tree.worldRegion?.id, tree.downloadedCountries, tree.countryAncestor],
  );
  // undefined while the new region's data is still on its way: the map keeps the last outline
  // meanwhile, so it glides to the next one instead of vanishing and being rebuilt.
  const freshBoundary = tree.regionKnownHub
    ? hubBoundary
    : regionMeta?.id === regionId
      ? (regionMeta?.boundaryGeoJson ?? null)
      : undefined;
  const [heldBoundary, setHeldBoundary] = useState<unknown>(null);
  if (freshBoundary !== undefined && freshBoundary !== heldBoundary) setHeldBoundary(freshBoundary);
  const mapBoundary = freshBoundary === undefined ? heldBoundary : freshBoundary;
  const showMapToggle = !!regionId && !!mapBoundary && !!mapAvailable;

  // No pack yet, but some species here are yours: they show, with the download offered above them.
  const needsPackBanner = data.needsPackFor && (
    <NeedsPackPrompt region={data.needsPackFor} onDownloaded={handlePackDownloaded} banner />
  );

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
          void refreshRegions().catch(ignore("Couldn't reload the region list"));
          load();
        }}
        onChecklistChanged={handleChecklistChanged}
        selectedSeaZones={selectedSeaZones}
        includeLand={includeLand}
        groupCountries={groupCountries}
        namingStyles={namingStyles}
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
        hasNeedsBetter={hasNeedsBetter}
        targetLists={targetLists ? regionListsFirst(targetLists, url.regionId) : undefined}
        shownCount={visibleItems?.length ?? null}
        totalLoaded={items?.length ?? null}
        seaZones={nearbySeaZones.zones}
        seaZonesRelevant={seaZonesRelevant}
        regionName={regionMeta?.name}
        onToggleSeaZone={seaZoneActions.toggleSeaZone}
        onSetAllSeaZones={seaZoneActions.setAllSeaZones}
        onSetIncludeLand={seaZoneActions.setIncludeLand}
        gridWidth={gridWidth}
        selectMode={selectMode}
        onEnterSelectMode={() => setSelectMode(true)}
        onExitSelectMode={exitSelectMode}
        mapShown={showMapToggle && !prefs.mapCollapsed}
        photoPlaces={
          regionMeta?.countryName ? { country: regionMeta.countryName, province: regionMeta.provinceName } : null
        }
      />

      {selectMode && visibleItems && (
        <CollectionSelectBar
          selectedIds={selectedIds}
          totalCount={visibleItems.length}
          onSelectAll={() => setPickedIds(new Set(visibleItems.map((i) => i.speciesId)))}
          onDeselectAll={() => setPickedIds(new Set())}
          onChanged={handleSpeciesChanged}
          onDone={exitSelectMode}
        />
      )}

      {selectMode && <Tip id="collection-select" className="mx-page mt-3" />}

      <main className="space-y-section p-page">
        {showMapToggle && !prefs.mapCollapsed && (
          <Suspense fallback={MAP_PLACEHOLDER}>
            <RegionMap
              boundaryGeoJson={mapBoundary}
              regionCode={regionMeta?.ebirdRegionCode}
              regionId={prefs.showMapPins ? regionId : null}
              regionName={regionMeta?.name}
            />
          </Suspense>
        )}

        {desktopFirstRun ? (
          <Navigate to="/onboarding" replace />
        ) : firstRunPrompt ? (
          <Panel className="py-12 text-center">
            <h2 className="text-title-1 font-bold text-ink">{t("collection.firstRun.title")}</h2>
            <p className="mx-auto mt-2 max-w-md text-body text-muted">{t("collection.firstRun.description")}</p>
            <div className="mt-6 flex items-center justify-center gap-4">
              <Link
                to={SPECIES_DOWNLOADS_PATH}
                state={{ backLabel: t("nav.collection") }}
                className={buttonClasses("primary", "lg")}
              >
                {t("collection.firstRun.chooseRegions")}
              </Link>
            </div>
          </Panel>
        ) : tree.regionKnownHub && items && items.length === 0 && data.downloadedHubCountryNames.length === 0 ? (
          <div className="rounded-panel border border-dashed border-line bg-surface-muted p-panel text-center">
            <p className="text-headline font-semibold text-ink">{t("collection.noHubCountries.title")}</p>
            <p className="mt-1 text-callout text-muted">
              <Trans
                i18nKey="collection.noHubCountries.description"
                components={{
                  regionsLink: (
                    <Link
                      to={SPECIES_DOWNLOADS_PATH}
                      state={{ backLabel: t("nav.collection") }}
                      className="text-link underline"
                    />
                  ),
                }}
              />
            </p>
          </div>
        ) : data.needsPackFor && items && items.length === 0 ? (
          <NeedsPackPrompt region={data.needsPackFor} onDownloaded={handlePackDownloaded} />
        ) : data.loadError ? (
          <EmptyState
            icon={ALERT_ICON}
            title={t("collection.loadFailed.title")}
            description={t("collection.loadFailed.description")}
            error={data.loadError}
            action={{ label: t("common.retry"), onClick: retry }}
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
          <>
            {needsPackBanner}
            {url.search ? (
              <EmptyState
                icon={SEARCH_ICON}
                title={t("collection.noSearchMatch.title", { search: url.search })}
                description={t("collection.noSearchMatch.description", { shortcut: shortcutLabel("palette") })}
                action={{ label: t("collection.noSearchMatch.clear"), onClick: () => url.setSearch("") }}
              />
            ) : (
              <EmptyState
                icon={SEARCH_ICON}
                title={t("collection.noFilterMatch.title", { count: items?.length ?? 0 })}
                description={t("collection.noFilterMatch.description")}
                action={{ label: t("collection.noFilterMatch.clear"), onClick: () => url.clearFilters() }}
              />
            )}
          </>
        ) : (
          <div
            // The one switch the cards' CSS reads (theme.css), so no card takes a prop.
            data-uncollected-colour={prefs.uncollectedColour || undefined}
            className={
              isGroupingPending || deferredSearch !== url.search
                ? "opacity-60 transition-opacity"
                : "transition-opacity"
            }
          >
            {needsPackBanner}
            {/* Only photographed species show without the taxon's pack; offer the rest. Other species
                never has a pack, so once some are added there's nothing more to offer. */}
            {data.taxonPackMissingFor &&
              data.taxonPackMissingFor.id === regionId &&
              data.taxonPackMissingFor.taxon === singleTaxonFilter &&
              !isOtherTaxaFilter(data.taxonPackMissingFor.taxon) && (
                <TaxonPackPrompt
                  regionId={data.taxonPackMissingFor.id}
                  regionName={data.taxonPackMissingFor.name}
                  taxon={data.taxonPackMissingFor.taxon}
                  onDownloaded={handlePackDownloaded}
                  photographed={visibleItems.filter((i) => i.state === "collected" || i.state === "seen").length}
                />
              )}
            <div data-tour="species">
              <GroupedSpeciesGrid
                items={visibleItems}
                regionId={regionId ?? undefined}
                groupBy={url.groupBy}
                collectedFirst={url.collectedFirst}
                seenFirst={url.seenFirst}
                targetFirst={url.targetFirst}
                sortBy={url.sortBy}
                searchRanks={searchRanked}
                onChanged={handleSpeciesChanged}
                cardMinWidth={prefs.cardMinWidth}
                regionName={regionMeta?.name}
                countryRegionId={tree.countryAncestor?.id}
                countryRegionName={tree.countryAncestor?.name}
                hideLabels={prefs.hideLabels}
                hideNames={prefs.hideNames}
                onWidthChange={setGridWidth}
                selection={gridSelection}
              />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
