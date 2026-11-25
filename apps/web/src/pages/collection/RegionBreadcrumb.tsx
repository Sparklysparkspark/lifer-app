import { formatNumber } from "../../lib/format";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import type { RegionSpeciesResult, RegionStats, RegionSummary } from "@lifer/shared";
import { api, apiPath } from "../../api/client";
import ProgressBar from "../../components/ProgressBar";
import { useToast } from "../../hooks/useToast";
import { errorMessage } from "../../lib/errorMessage";
import type { ChecklistTarget } from "../../lib/checklistAdditions";
import AreaPills from "../../components/AreaPills";
import { useRegionsWithPhotos } from "../../hooks/useRegionsWithPhotos";
import Button from "../../components/Button";
import Menu, { MenuItem, MenuLink, MenuNote, MenuPanel } from "../../components/Menu";
import { useDropdownMenu } from "../../hooks/useDropdownMenu";
import { groupsForCountries, useConnection, usePackIndex } from "../../lib/packIndex";
import AddGroupsModal from "./AddGroupsModal";
import AddTargetsModal from "../../components/AddTargetsModal";
import AddOtherSpeciesModal, { useAddOtherSpeciesTabs } from "./AddOtherSpeciesModal";
import { SPECIES_DOWNLOADS_PATH } from "../../lib/speciesDownloads";

function addTargets(
  region: { id: string; name: string },
  seaZones: Array<{ id: string; name: string }>,
  includeLand: boolean,
): ChecklistTarget[] {
  const land: ChecklistTarget = { kind: "region", id: region.id, name: region.name };
  const sea = seaZones.map((z): ChecklistTarget => ({ kind: "seaZone", id: z.id, name: z.name }));
  return includeLand || sea.length === 0 ? [land, ...sea] : [...sea, land];
}

// The main-screen drill-down: no region means everything collected worldwide; picking one
// narrows the same grid to that region's checklist.
export default function RegionBreadcrumb({
  regionId,
  worldRegion,
  downloadedCountries,
  breadcrumb,
  navigateToRegion,
  regionMeta,
  regionStats,
  regionKnownHub,
  hubStats,
  showEbirdLink,
  mapToggle,
  childRegions: children,
  allChildren,
  availableRegionIds,
  onDrilledDown,
  onChecklistChanged,
  selectedSeaZones,
  includeLand,
  groupCountries,
  namingStyles,
}: {
  regionId: string | null;
  worldRegion: RegionSummary | undefined;
  downloadedCountries: RegionSummary[];
  breadcrumb: RegionSummary[];
  navigateToRegion: (id: string | null) => void;
  regionMeta: RegionSpeciesResult["region"] | null;
  regionStats: RegionStats | null;
  regionKnownHub: boolean;
  hubStats: RegionStats | null;
  showEbirdLink: boolean;
  mapToggle: { collapsed: boolean; onToggle: () => void } | null;
  childRegions: RegionSummary[];
  allChildren: RegionSummary[];
  availableRegionIds: Set<string> | null;
  onDrilledDown: () => void;
  /** After a species was added to this region's checklist by hand. */
  onChecklistChanged: () => void;
  /** Sea zones ticked on this view, which "+ Add a species" can add to as well. */
  selectedSeaZones: Array<{ id: string; name: string }>;
  /** False when the view shows only the ticked sea zones, so they come first in the dialog. */
  includeLand: boolean;
  /** The countries "Download species lists" offers groups for (countriesInView). */
  groupCountries: Array<{ id: string; name: string }>;
  namingStyles: string[];
}) {
  const { t } = useTranslation();
  const [drillingDown, setDrillingDown] = useState(false);
  const regionsWithPhotos = useRegionsWithPhotos();
  const addMenu = (
    <AddSpeciesMenu
      countries={groupCountries}
      onlyDownloaded={!regionId || regionKnownHub}
      namingStyles={namingStyles}
      targets={regionMeta && !regionKnownHub ? addTargets(regionMeta, selectedSeaZones, includeLand) : null}
      regionId={regionId}
      listRegion={regionMeta && !regionKnownHub ? { id: regionMeta.id, name: regionMeta.name } : null}
      onChecklistChanged={onChecklistChanged}
    />
  );
  const toast = useToast();

  async function drillDown() {
    if (!regionId) return;
    setDrillingDown(true);
    try {
      await api.post(apiPath("/regions/{id}/drill-down", { id: regionId }), {});
      onDrilledDown();
    } catch (err) {
      toast.error(errorMessage(err, t("collection.breadcrumb.drillDownFailed")));
    } finally {
      setDrillingDown(false);
    }
  }

  if (!regionId) {
    if (!worldRegion) return <div className="border-b border-line bg-surface px-page py-2" />;
    return (
      <div data-tour="collection-header" className="space-y-2 border-b border-line bg-surface px-page pt-3 pb-4">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <h1 className="text-large-title font-bold text-ink">{t("collection.breadcrumb.allSpecies")}</h1>
          {addMenu}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-callout text-muted">
          <Button variant="link" onClick={() => navigateToRegion(worldRegion.id)} className="font-medium text-link!">
            {t("collection.breadcrumb.browseByRegion")}
          </Button>
          {/* Downloaded countries one click away, instead of World, continent, country; two rows at most. */}
          {downloadedCountries.length > 0 && (
            <div className="min-w-0 flex-1">
              <AreaPills areas={downloadedCountries} onPick={navigateToRegion} />
            </div>
          )}
        </div>
      </div>
    );
  }

  const canDrillDown = !!regionMeta?.canDrillDown && !regionMeta.hasChildren;

  // The region's name is the page's title; the path above it leads back out. The trail's name
  // first: a group holding one province titles that province's page.
  const current = breadcrumb.at(-1);
  const title = current?.name ?? regionMeta?.name;
  const stats = !regionKnownHub ? regionStats : hubStats;

  return (
    <div data-tour="collection-header" className="border-b border-line bg-surface px-page pt-3 pb-4">
      <div className="space-y-3">
        <nav
          aria-label={t("collection.breadcrumb.navLabel")}
          className="flex flex-wrap items-center gap-1 text-callout text-muted"
        >
          <Button variant="link" onClick={() => navigateToRegion(null)} className="text-link!">
            {t("collection.breadcrumb.allSpecies")}
          </Button>
          {breadcrumb.slice(0, -1).map((r) => (
            <span key={r.id} className="flex items-center gap-1">
              <span aria-hidden="true">›</span>
              <Button variant="link" onClick={() => navigateToRegion(r.id)} className="text-link!">
                {r.name}
              </Button>
            </span>
          ))}
        </nav>
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <h1 className="text-large-title font-bold text-ink">{title}</h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {addMenu}
            {mapToggle && (
              <Button variant="link" onClick={mapToggle.onToggle} className="text-link!">
                {mapToggle.collapsed ? t("collection.breadcrumb.showMap") : t("collection.breadcrumb.hideMap")}
              </Button>
            )}
          </div>
        </div>
        {stats && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <p className="text-title-2 font-semibold text-ink">
              {formatNumber(stats.collected)}{" "}
              <span className="text-callout font-normal text-muted">
                {t("collection.breadcrumb.ofTotal", { total: formatNumber(stats.total) })}
                {regionKnownHub && (
                  <span title={t("collection.breadcrumb.hubTitle")}>
                    {" "}
                    {t("collection.breadcrumb.inDownloadedCountries")}
                  </span>
                )}
              </span>
            </p>
            <ProgressBar
              determinate
              value={stats.total ? stats.collected / stats.total : 0}
              label={
                regionKnownHub ? t("collection.breadcrumb.progressHub") : t("collection.breadcrumb.progressRegion")
              }
              title={foundText(stats.collected, stats.total)}
              className="w-56"
            />
            <p className="text-callout text-muted" title={t("collection.toolbar.seenTitle")}>
              {t("collection.breadcrumb.seen", { count: formatNumber(stats.seen) })}
            </p>
            {regionMeta && !regionKnownHub && regionMeta.ebirdRegionCode && showEbirdLink && (
              <div className="ml-auto">
                <a
                  href={`https://ebird.org/region/${regionMeta.ebirdRegionCode}/illustrated-checklist`}
                  // eslint-disable-next-line no-restricted-syntax -- baseline, migrate to openExternal() or a shared link component
                  target="_blank"
                  rel="noreferrer"
                  className="text-callout text-link hover:underline"
                >
                  {t("collection.breadcrumb.ebirdChecklist")}
                </a>
              </div>
            )}
          </div>
        )}
        {(children.length > 0 || canDrillDown) && (
          <AreaPills
            label={t("collection.breadcrumb.areasIn", { region: title })}
            areas={children}
            withPhotos={regionsWithPhotos}
            onPick={navigateToRegion}
            trailing={
              canDrillDown && (
                <Button variant="secondary" size="sm" onClick={drillDown} loading={drillingDown}>
                  {drillingDown ? t("collection.breadcrumb.drillingDown") : t("collection.breadcrumb.drillDown")}
                </Button>
              )
            }
          />
        )}
        {availableRegionIds && allChildren.length > 0 && children.length === 0 && (
          <p className="text-footnote text-muted">
            <Trans
              i18nKey="collection.breadcrumb.noCountries"
              components={{
                a: (
                  <Link to={SPECIES_DOWNLOADS_PATH} state={{ backLabel: t("nav.collection") }} className="underline" />
                ),
              }}
            />
          </p>
        )}
      </div>
    </div>
  );
}

/** Add species: download species lists (animal groups for the countries in view, with a way on to
 *  more countries), add other species (search, a group from iNaturalist, a pasted list), or add
 *  targets (a group by name, or an imported list). */
function AddSpeciesMenu({
  countries,
  onlyDownloaded,
  namingStyles,
  targets,
  regionId,
  listRegion,
  onChecklistChanged,
}: {
  countries: Array<{ id: string; name: string }>;
  onlyDownloaded: boolean;
  namingStyles: string[];
  /** Where a searched species can go: a single region (and its sea zones) with a checklist. */
  targets: ChecklistTarget[] | null;
  regionId: string | null;
  /** The region with a checklist in view: where a group and a pasted list go by default. */
  listRegion: { id: string; name: string } | null;
  onChecklistChanged: () => void;
}) {
  const { t } = useTranslation();
  const menu = useDropdownMenu();
  const canAddOther = useAddOtherSpeciesTabs(!!targets).length > 0;
  const [addingOther, setAddingOther] = useState(false);
  const [choosingGroups, setChoosingGroups] = useState(false);
  const [importingTargets, setImportingTargets] = useState(false);
  const { packs, freeBytes, indexUnavailable, listProgress, sizesPending } = usePackIndex();
  const connection = useConnection();
  const countryNames = countries.map((c) => c.name);
  // What's installed shows at once; the rest of the list fills in when it lands.
  const groups = packs ? groupsForCountries(packs, countryNames) : [];
  const listReady = !!packs && !indexUnavailable;
  // Only facts the user can act on; the item itself never goes dead.
  const note =
    countries.length === 0
      ? t("collection.addGroups.noCountries")
      : listReady && !groups.some((g) => !g.downloaded)
        ? t("collection.addGroups.allDownloaded")
        : null;
  return (
    <>
      <Menu
        open={menu.openKey === true}
        onToggle={() => menu.setOpenKey(menu.openKey ? null : true)}
        menuRef={menu.ref}
        className="relative shrink-0"
        trigger={(props) => (
          <Button variant="link" className="text-link!" {...props}>
            {t("collection.breadcrumb.addSpecies")}
          </Button>
        )}
      >
        <MenuPanel className="w-64">
          {/* No downloaded country here: the item goes where one can be downloaded instead. */}
          {countries.length === 0 ? (
            <MenuLink to={SPECIES_DOWNLOADS_PATH} state={{ backLabel: t("nav.collection") }}>
              {t("collection.addGroups.menuItem")}
            </MenuLink>
          ) : (
            <MenuItem onSelect={() => setChoosingGroups(true)}>{t("collection.addGroups.menuItem")}</MenuItem>
          )}
          {note && <MenuNote>{note}</MenuNote>}
          {canAddOther && (
            <MenuItem onSelect={() => setAddingOther(true)}>{t("collection.addGroups.addOther")}</MenuItem>
          )}
          <MenuItem onSelect={() => setImportingTargets(true)}>{t("targetLists.addAction")}</MenuItem>
        </MenuPanel>
      </Menu>
      {choosingGroups && (
        <AddGroupsModal
          countryNames={countryNames}
          groups={groups}
          freeBytes={freeBytes}
          connection={connection}
          listReady={listReady}
          listProgress={listProgress}
          sizesPending={sizesPending}
          onlyDownloaded={onlyDownloaded}
          namingStyles={namingStyles}
          onClose={() => setChoosingGroups(false)}
        />
      )}
      {addingOther && (
        <AddOtherSpeciesModal
          targets={targets}
          region={listRegion}
          onClose={() => setAddingOther(false)}
          onAdded={onChecklistChanged}
        />
      )}
      {importingTargets && (
        <AddTargetsModal
          regionId={regionId}
          regionName={listRegion?.name}
          onClose={() => setImportingTargets(false)}
          onChanged={onChecklistChanged}
        />
      )}
    </>
  );
}

/** "4.2% found (61 of 1,450)": a decimal while the share is small, where a whole percent hides progress. */
function foundText(collected: number, total: number): string {
  const percent = total ? (collected / total) * 100 : 0;
  const shown = percent > 0 && percent < 10 ? percent.toFixed(1) : String(Math.round(percent));
  return `${shown}% found (${formatNumber(collected)} of ${formatNumber(total)})`;
}
