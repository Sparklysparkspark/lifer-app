import { useMemo, type TransitionStartFunction } from "react";
import { useTranslation } from "react-i18next";
import Pill from "../../components/Pill";
import SelectModeToggle from "../../components/SelectModeToggle";
import FilterPopover, { FilterFieldLabel, FilterSectionHeading } from "../../components/FilterPopover";
import Checkbox from "../../components/Checkbox";
import Button from "../../components/Button";
import { FilterCheckbox, PhotoViewMenu, type PhotoViewMenuProps } from "../../components/PhotoGridControls";
import type { GroupOption, SortOption, ViewSection } from "../../lib/photoGridSections";
import Select from "../../components/Select";
import SearchInput from "../../components/SearchInput";
import { taxonFilterLabel } from "./taxonLabels";
import type { CollectionUrlState, TraitFilter } from "./useCollectionUrlState";
import { TIER_ORDER as TIER_FILTER_ORDER, tierLabel } from "../../lib/speciesGroups";
import type { CollectionDisplayPrefs } from "./useCollectionDisplayPrefs";
import { formatNumber } from "../../lib/format";
import type { TargetList } from "../../lib/targetLists";
import { autoFillColumns, fluidSizeStepIndex, fluidSizeSteps, gapPxFor } from "../../components/speciesGridLayout";

const CARD_MIN_WIDTH = 120;
const CARD_MAX_WIDTH = 320;
const VIEW_SECTIONS: readonly ViewSection[] = [
  "group",
  "sort",
  "size",
  "order",
  "hideNames",
  "mapPins",
  "counting",
  "nameSettings",
];

const GROUPS: readonly GroupOption[] = ["none", "broad", "group", "tier"];
const GROUPS_IN_REGION: readonly GroupOption[] = [...GROUPS, "localTier"];
// Related species together first, as in eBird and printed guides.
const SORTS: readonly SortOption[] = ["taxonomic", "name", "scientific", "rarity"];
const SORTS_IN_REGION: readonly SortOption[] = [...SORTS, "localRarity"];

export default function CollectionToolbar({
  url,
  prefs,
  startTransition,
  availableTaxonFilters,
  namingStyles,
  availableYears = [],
  hasGhost,
  hasLost,
  hasNeedsBetter,
  targetLists,
  shownCount,
  totalLoaded,
  seaZones = [],
  seaZonesRelevant = false,
  regionName,
  onToggleSeaZone,
  onSetAllSeaZones,
  onSetIncludeLand,
  gridWidth,
  photoPlaces,
  selectMode,
  onEnterSelectMode,
  onExitSelectMode,
  mapShown,
  show,
  bare,
}: {
  url: CollectionUrlState;
  prefs: CollectionDisplayPrefs;
  startTransition: TransitionStartFunction;
  availableTaxonFilters: string[];
  namingStyles: string[];
  availableYears?: number[];
  hasGhost: boolean;
  hasLost: boolean;
  /** Some species carry the "needs a better photo" mark, so its filter is worth offering. */
  hasNeedsBetter: boolean;
  /** The user's target lists, the viewed region's first, for the Targets filter. */
  targetLists?: TargetList[];
  shownCount: number | null;
  totalLoaded: number | null;
  seaZones?: Array<{ id: string; name: string }>;
  seaZonesRelevant?: boolean;
  regionName?: string;
  onToggleSeaZone?: (zoneId: string, checked: boolean) => void;
  onSetAllSeaZones?: (checked: boolean) => void;
  onSetIncludeLand?: (checked: boolean) => void;
  /** The species grid's content width, once measured. */
  gridWidth: number | null;
  /** The viewed region's country, and its own name when it's a province; null without a country. */
  photoPlaces?: { country: string; province: string | null } | null;
  /** Without these the list has no Select mode. */
  selectMode?: boolean;
  onEnterSelectMode?: () => void;
  onExitSelectMode?: () => void;
  /** The region map is on screen, so its pins are worth offering. */
  mapShown?: boolean;
  /** A page with a photo view too (a trip): View's Species or Photos switch. */
  show?: PhotoViewMenuProps["show"];
  /** Just the controls, for a page header's actions, instead of the Collection's own strip. */
  bare?: boolean;
}) {
  const { t } = useTranslation();
  const sizeSteps = useMemo(
    () => (url.groupBy === "none" && gridWidth ? fluidSizeSteps(gridWidth, CARD_MIN_WIDTH, CARD_MAX_WIDTH) : null),
    [url.groupBy, gridWidth],
  );
  const sizeStepIndex = sizeSteps ? fluidSizeStepIndex(sizeSteps, prefs.cardMinWidth) : 0;
  const { regionId, taxonFilters, seaZoneIds, updateParam } = url;
  // photoPlaces is set only for a region checklist (not a hub), whose rows say where photos were taken.
  const photosTakenOffered = !!photoPlaces && !!regionName;
  // Only departures from the default count (collectedFirst is on by default).
  const activeFilterCount =
    (photosTakenOffered && url.photosTakenFilter !== "anywhere" ? 1 : 0) +
    (url.stateFilter !== "all" ? 1 : 0) +
    (url.ghostOnly ? 1 : 0) +
    (url.lostOnly ? 1 : 0) +
    (url.needsBetterOnly ? 1 : 0) +
    (url.likelyThisMonthOnly ? 1 : 0) +
    (url.yearFilter ? 1 : 0) +
    (url.introducedFilter !== "any" ? 1 : 0) +
    (url.endemicFilter !== "any" ? 1 : 0) +
    (url.vagrantFilter !== "any" ? 1 : 0) +
    (url.tierFilters.size > 0 ? 1 : 0) +
    (taxonFilters.size > 0 ? 1 : 0);

  // A filter stays on screen while set, even when this list has nothing it applies to, so it can
  // always be undone.
  const showGhost = hasGhost || url.ghostOnly;
  const showLost = hasLost || url.lostOnly;
  const activeYear = Number(url.yearFilter);
  const years =
    url.yearFilter && !availableYears.includes(activeYear)
      ? [...availableYears, activeYear].sort((a, b) => b - a)
      : availableYears;
  // Only the zones still offered count, so a stale id can't tick or half-tick All.
  const checkedZones = seaZones.filter((z) => seaZoneIds.includes(z.id)).length;

  function toggleTier(tier: string) {
    const next = new Set(url.tierFilters);
    if (!next.delete(tier)) next.add(tier);
    updateParam("tiers", TIER_FILTER_ORDER.filter((x) => next.has(x)).join(",") || null);
  }

  const controls = (
    <>
      <SearchInput
        value={url.search}
        onChange={url.setSearch}
        placeholder={t("collection.toolbar.searchPlaceholder")}
        className={bare ? "w-full sm:w-56" : "w-60"}
        aria-label={t("collection.toolbar.searchLabel")}
      />
      {/* The region's own counts never change with filters, so show what a filter took out. */}
      {totalLoaded != null && shownCount != null && shownCount !== totalLoaded && (
        <span className="text-footnote text-muted">
          {t("collection.toolbar.showing", { shown: formatNumber(shownCount), total: formatNumber(totalLoaded) })}
        </span>
      )}
      {shownCount && onEnterSelectMode && onExitSelectMode ? (
        <SelectModeToggle active={!!selectMode} onEnter={onEnterSelectMode} onExit={onExitSelectMode} />
      ) : null}
      {/* How the list is laid out, apart from what it shows (Filters): grouping, order, card size
          and what the cards say. */}
      <PhotoViewMenu
        sections={show ? ["show", ...VIEW_SECTIONS] : VIEW_SECTIONS}
        show={show}
        activeCount={
          (url.groupBy !== "none" ? 1 : 0) +
          (url.sortBy !== "taxonomic" ? 1 : 0) +
          (url.collectedFirst ? 0 : 1) +
          (url.seenFirst ? 1 : 0) +
          (url.targetFirst ? 1 : 0)
        }
        // Regrouping a large list is slow, so it runs in a transition that keeps the old grid up.
        group={{
          value: url.groupBy as GroupOption,
          options: regionId ? GROUPS_IN_REGION : GROUPS,
          onChange: (v) => startTransition(() => updateParam("group", v === "none" ? null : v)),
        }}
        // Local rarity only comes back on a region's checklist.
        sort={{
          value: url.sortBy as SortOption,
          options: regionId ? SORTS_IN_REGION : SORTS,
          onChange: (v) => startTransition(() => updateParam("sort", v === "taxonomic" ? null : v)),
        }}
        // Ungrouped cards stretch to fill each row, so only a new column count shows: one stop each.
        size={
          sizeSteps
            ? {
                value: sizeStepIndex,
                min: 0,
                max: sizeSteps.length - 1,
                step: 1,
                disabled: sizeSteps.length <= 1,
                onChange: (i) => prefs.setCardMinWidth(sizeSteps[i]),
                label: t("collection.toolbar.sizeLabel"),
                valueText: t("collection.toolbar.sizeColumns", {
                  count: autoFillColumns(gridWidth!, sizeSteps[sizeStepIndex], gapPxFor(sizeSteps[sizeStepIndex])),
                }),
              }
            : {
                value: prefs.cardMinWidth,
                min: CARD_MIN_WIDTH,
                max: CARD_MAX_WIDTH,
                step: 10,
                onChange: prefs.setCardMinWidth,
                label: t("collection.toolbar.sizeLabel"),
              }
        }
        order={[
          {
            key: "collected",
            checked: url.collectedFirst,
            onChange: (c) => updateParam("collectedFirst", c ? null : "0"),
            label: t("collection.toolbar.photographedFirst"),
            title: t("collection.toolbar.collectedTitle"),
          },
          {
            key: "seen",
            checked: url.seenFirst,
            onChange: (c) => updateParam("seenFirst", c ? "1" : null),
            label: t("collection.toolbar.seenFirst"),
            title: t("collection.toolbar.seenTitle"),
          },
          {
            key: "target",
            checked: url.targetFirst,
            onChange: (c) => updateParam("targetFirst", c ? "1" : null),
            label: t("collection.toolbar.targetsFirst"),
            title: t("collection.toolbar.targetTitle"),
          },
          {
            key: "uncollectedColour",
            checked: prefs.uncollectedColour,
            onChange: prefs.setUncollectedColour,
            label: t("collection.toolbar.uncollectedColour"),
            title: t("collection.toolbar.uncollectedColourTitle"),
          },
        ]}
        hideNames={{ checked: prefs.hideNames, onChange: prefs.setHideNames }}
        mapPins={mapShown ? { checked: prefs.showMapPins, onChange: prefs.setShowMapPins } : undefined}
        // Place names are data. A province choice reads as the country where there's no province.
        counting={
          photoPlaces
            ? {
                value: prefs.photographedIn === "province" && !photoPlaces.province ? "country" : prefs.photographedIn,
                onChange: prefs.setPhotographedIn,
                options: [
                  { value: "anywhere", label: t("collection.toolbar.countPhotosAnywhere") },
                  { value: "country", label: photoPlaces.country },
                  ...(photoPlaces.province ? [{ value: "province", label: photoPlaces.province }] : []),
                ],
              }
            : undefined
        }
      />
      <FilterPopover activeCount={activeFilterCount}>
        <div className="space-y-1">
          <FilterSectionHeading>{t("collection.toolbar.animals")}</FilterSectionHeading>
          <div className="flex max-h-56 flex-wrap gap-1 overflow-y-auto">
            {availableTaxonFilters.map((taxon) => (
              <Pill
                key={taxon}
                size="sm"
                active={taxonFilters.has(taxon)}
                onClick={() => {
                  const next = new Set(taxonFilters);
                  if (next.has(taxon)) next.delete(taxon);
                  else next.add(taxon);
                  updateParam("taxon", next.size > 0 ? [...next].join(",") : null);
                }}
              >
                {taxonFilterLabel(taxon, namingStyles)}
              </Pill>
            ))}
          </div>
          {taxonFilters.size > 0 && (
            <Button variant="link" size="sm" onClick={() => updateParam("taxon", null)} className="mt-1">
              {t("collection.toolbar.clearAnimals")}
            </Button>
          )}
        </div>
        <div className="border-t border-line pt-2">
          <FilterSectionHeading>{t("collection.toolbar.show")}</FilterSectionHeading>
          <Select
            aria-label={t("collection.toolbar.show")}
            value={url.stateFilter}
            onChange={(e) => updateParam("show", e.target.value === "all" ? null : e.target.value)}
            className="w-full"
          >
            <option value="all">{t("collection.toolbar.showAll")}</option>
            <option value="collected" title={t("collection.toolbar.collectedTitle")}>
              {t("collection.toolbar.showCollected")}
            </option>
            <option value="seen" title={t("collection.toolbar.seenTitle")}>
              {t("collection.toolbar.showSeen")}
            </option>
            <option value="target" title={t("collection.toolbar.targetTitle")}>
              {t("collection.toolbar.showTargets")}
            </option>
            <option value="unseen">{t("collection.toolbar.showUnseen")}</option>
          </Select>
          {url.stateFilter === "target" && !!targetLists?.length && (
            <Select
              aria-label={t("targetLists.filterLabel")}
              value={targetLists.some((l) => l.id === url.targetListId) ? url.targetListId! : ""}
              onChange={(e) => updateParam("targetList", e.target.value || null)}
              className="mt-1.5 w-full"
            >
              <option value="">{t("targetLists.allTargets")}</option>
              {targetLists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.regionName ? t("targetLists.nameWithRegion", { name: l.name, region: l.regionName }) : l.name}
                </option>
              ))}
            </Select>
          )}
          {/* Only a country, group or province checklist knows where each photo was taken. */}
          {photosTakenOffered && (
            <div className="mt-1.5 space-y-1">
              <FilterFieldLabel>{t("collection.toolbar.photosTaken")}</FilterFieldLabel>
              <Select
                aria-label={t("collection.toolbar.photosTaken")}
                value={url.photosTakenFilter}
                onChange={(e) => updateParam("photosTaken", e.target.value === "anywhere" ? null : e.target.value)}
                className="w-full"
                title={t("collection.toolbar.photosTakenTitle")}
              >
                <option value="anywhere">{t("collection.toolbar.photosTakenAnywhere")}</option>
                <option value="here">{t("collection.toolbar.photosTakenHere", { region: regionName })}</option>
                <option value="elsewhere">
                  {t("collection.toolbar.photosTakenElsewhere", { region: regionName })}
                </option>
              </Select>
            </div>
          )}
          {/* Kept while checked, so it can be unchecked once the last mark is gone. */}
          {(hasNeedsBetter || url.needsBetterOnly) && (
            <div className="mt-1.5">
              <FilterCheckbox
                checked={url.needsBetterOnly}
                onChange={(c) => updateParam("needsBetter", c ? "1" : null)}
                title={t("collection.toolbar.needsBetterOnlyTitle")}
              >
                {t("collection.toolbar.needsBetterOnly")}
              </FilterCheckbox>
            </div>
          )}
        </div>
        <div className="space-y-1.5 border-t border-line pt-2">
          <FilterSectionHeading>
            {regionId ? t("collection.toolbar.rarityHere") : t("collection.toolbar.rarity")}
          </FilterSectionHeading>
          <div className="flex flex-wrap gap-1">
            {TIER_FILTER_ORDER.map((tier) => (
              <Pill key={tier} size="sm" active={url.tierFilters.has(tier)} onClick={() => toggleTier(tier)}>
                {tierLabel(tier)}
              </Pill>
            ))}
          </div>
          <TraitSelect
            label={t("collection.toolbar.endemic")}
            value={url.endemicFilter}
            onChange={(v) => updateParam("endemic", v)}
            only={t("collection.toolbar.endemicOnly")}
            hide={t("collection.toolbar.endemicHide")}
            title={t("collection.toolbar.endemicTitle")}
          />
          {/* Whether a species is introduced or a vagrant is about one place, so only on a region,
              or while still set so it can be undone. */}
          {(regionId || url.introducedFilter !== "any") && (
            <TraitSelect
              label={t("collection.toolbar.introduced")}
              value={url.introducedFilter}
              onChange={(v) => updateParam("introduced", v)}
              only={t("collection.toolbar.introducedOnly")}
              hide={t("collection.toolbar.introducedHide")}
              title={t("collection.toolbar.introducedTitle")}
            />
          )}
          {(regionId || url.vagrantFilter !== "any") && (
            <TraitSelect
              label={t("collection.toolbar.vagrants")}
              value={url.vagrantFilter}
              onChange={(v) => updateParam("vagrant", v)}
              only={t("collection.toolbar.vagrantsOnly")}
              hide={t("collection.toolbar.vagrantsHide")}
              title={t("collection.toolbar.vagrantsTitle")}
            />
          )}
        </div>
        {(regionId || years.length > 0 || url.likelyThisMonthOnly) && (
          <div className="space-y-1.5 border-t border-line pt-2">
            <FilterSectionHeading>{t("collection.toolbar.whenSection")}</FilterSectionHeading>
            {(regionId || url.likelyThisMonthOnly) && (
              <FilterCheckbox
                checked={url.likelyThisMonthOnly}
                onChange={(c) => updateParam("likelyThisMonth", c ? "1" : null)}
                title={t("collection.toolbar.likelyThisMonthTitle")}
              >
                {t("collection.toolbar.likelyThisMonth")}
              </FilterCheckbox>
            )}
            {years.length > 0 && (
              <div className="space-y-1">
                <FilterFieldLabel>{t("collection.toolbar.year")}</FilterFieldLabel>
                <Select
                  aria-label={t("collection.toolbar.year")}
                  value={url.yearFilter}
                  onChange={(e) => updateParam("year", e.target.value || null)}
                  className="w-full"
                >
                  <option value="">{t("collection.toolbar.anyYear")}</option>
                  {years.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </div>
        )}
        {/* Only offered once the list actually has a rarely recorded species or one not seen in 25 years. */}
        {(showGhost || showLost) && (
          <div className="space-y-1.5 border-t border-line pt-2">
            <FilterSectionHeading>{t("collection.toolbar.recordsSection")}</FilterSectionHeading>
            {showGhost && (
              <FilterCheckbox
                checked={url.ghostOnly}
                onChange={(c) => updateParam("ghostOnly", c ? "1" : null)}
                title={t("collection.toolbar.ghostOnlyTitle")}
              >
                {t("collection.toolbar.ghostOnly")}
              </FilterCheckbox>
            )}
            {showLost && (
              <FilterCheckbox
                checked={url.lostOnly}
                onChange={(c) => updateParam("lostOnly", c ? "1" : null)}
                title={t("collection.toolbar.lostOnlyTitle")}
              >
                {t("collection.toolbar.lostOnly")}
              </FilterCheckbox>
            )}
          </div>
        )}
      </FilterPopover>
    </>
  );
  if (bare) return controls;

  return (
    // data-header-extension: TitleBarDragRegion treats this strip as the bottom of the header.
    <div
      data-header-extension=""
      data-tour="toolbar"
      className="relative flex flex-wrap items-center gap-3 border-b border-line bg-surface py-2 pl-6 pr-12 text-footnote"
    >
      {controls}
      {seaZonesRelevant && seaZones.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-muted">
          <span>{t("collection.toolbar.seaZones")}</span>
          {seaZones.length > 1 && (
            <Checkbox
              size="sm"
              checked={checkedZones === seaZones.length}
              indeterminate={checkedZones > 0 && checkedZones < seaZones.length}
              onChange={(checked) => onSetAllSeaZones?.(checked)}
              labelClassName="font-medium"
            >
              {t("collection.toolbar.seaZonesAll")}
            </Checkbox>
          )}
          {seaZones.map((z) => (
            <Checkbox
              key={z.id}
              size="sm"
              checked={seaZoneIds.includes(z.id)}
              onChange={(checked) => onToggleSeaZone?.(z.id, checked)}
            >
              {z.name}
            </Checkbox>
          ))}
          {/* With a zone checked, lets it show only that zone's sea life instead of adding to the land list. */}
          {checkedZones > 0 && (
            <Checkbox
              size="sm"
              checked={url.includeLand}
              onChange={(checked) => onSetIncludeLand?.(checked)}
              className="border-l border-line pl-2"
            >
              {regionName
                ? t("collection.toolbar.includeLand", { region: regionName })
                : t("collection.toolbar.includeLandUnnamed")}
            </Checkbox>
          )}
        </div>
      )}
    </div>
  );
}

function TraitSelect({
  label,
  value,
  onChange,
  only,
  hide,
  title,
}: {
  label: string;
  value: TraitFilter;
  onChange: (value: string | null) => void;
  only: string;
  hide: string;
  title: string;
}) {
  const { t } = useTranslation();
  return (
    <Select
      label={label}
      value={value}
      onChange={(e) => onChange(e.target.value === "any" ? null : e.target.value)}
      className="w-full"
      title={title}
    >
      <option value="any">{t("collection.toolbar.traitAny")}</option>
      <option value="only">{only}</option>
      <option value="hide">{hide}</option>
    </Select>
  );
}
