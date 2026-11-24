import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ALL_TAXON_CLASSES, LIFE_STAGES, SEXES, SHOT_ACTIONS, SHOT_FRAMINGS, taxonDisplayLabel } from "@lifer/shared";
import { useRegions } from "../hooks/useRegions";
import { useInatStatus } from "../hooks/useInatStatus";
import { regionLabel } from "../lib/regionSearch";
import { TIER_ORDER, tierLabel } from "../lib/speciesGroups";
import Pill from "./Pill";
import StarRangePicker from "./StarRangePicker";
import Select from "./Select";
import Button, { IconButton } from "./Button";
import RegionBrowser from "./RegionBrowser";
import PlaceNameInput from "./PlaceNameInput";
import FilterPopover, { FilterFieldLabel, FilterSectionHeading } from "./FilterPopover";
import SearchInput from "./SearchInput";
import { formatNumber } from "../lib/format";
import { normalizeForSearch } from "../lib/searchNormalize";
import { useAppearanceLabels } from "../lib/appearance";
import { DateRangeField, FilterCheckbox, MediaFilterField, RawFilterFields } from "./PhotoGridControls";
import {
  SHOT_ACTION_LABELS,
  SHOT_FRAMING_LABELS,
  UNCATEGORIZED_REGION_ID,
  soleRegionId,
  toggleInList,
  toggleInSet,
} from "../pages/gallery/galleryHelpers";
import type { GalleryFacets } from "../pages/gallery/useGalleryFacets";
import type { GalleryFilters } from "../pages/gallery/useGalleryFilters";
import type { AppearanceKind } from "../pages/gallery/types";
import type { PhotoFilterSection } from "../lib/photoGridSections";

// Choices for the Number of animals filter; larger groups are better found by searching ("50 geese").
const ANIMAL_COUNTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 30];

interface FilterFieldsProps {
  filters: GalleryFilters;
  facets: GalleryFacets;
  tagOptions: string[];
  /** Which sections this page has. Each renders the same way on every page. */
  sections: readonly PhotoFilterSection[];
  /** The "species" section's choices: a page's species with their photo counts. */
  species?: SpeciesFilterChoices;
}

export interface SpeciesFilterChoices {
  options: ReadonlyArray<{ id: string; label: string; count: number }>;
  selected: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
}

/** The Filters button and menu every photo grid shares. The badge is filters.activeFilterCount;
 *  with any filter on, the menu ends with Clear all, so every grid page has it. */
export default function PhotoFiltersMenu(props: FilterFieldsProps) {
  const { t } = useTranslation();
  const { filters, species } = props;
  const activeCount = filters.activeFilterCount + (species?.selected.size ? 1 : 0);
  return (
    <FilterPopover activeCount={activeCount}>
      <PhotoFilterFields {...props} />
      {activeCount > 0 && (
        <div className="mt-2 flex justify-end border-t border-line pt-2">
          <Button
            variant="link"
            size="sm"
            onClick={() => {
              filters.clearFilters();
              species?.onChange(new Set());
            }}
          >
            {t("gallery.toolbar.clearAll")}
          </Button>
        </div>
      )}
    </FilterPopover>
  );
}

/** The Filters menu's fields, also the smart album rule builder's. */
export function PhotoFilterFields({ filters, facets, tagOptions, sections, species }: FilterFieldsProps) {
  const { t } = useTranslation();
  const { query } = filters;
  const { selectedTaxa, dateFrom, dateTo, regionIds, tiers, tierRegionId } = query;
  const { regions } = useRegions();
  const inat = useInatStatus();
  const regionsById = useMemo(() => new Map((regions ?? []).map((r) => [r.id, r])), [regions]);
  const on = new Set<PhotoFilterSection>(sections);
  const noRegion = regionIds.includes(UNCATEGORIZED_REGION_ID);
  const pickedRegionIds = regionIds.filter((id) => id !== UNCATEGORIZED_REGION_ID);
  // What's typed in the place picker; only a picked suggestion filters.
  const [placeDraft, setPlaceDraft] = useState("");
  const tierRegion = tierRegionId ? regions?.find((r) => r.id === tierRegionId)?.name : null;
  const taxonPill = (tc: string) => (
    <Pill
      key={tc}
      size="sm"
      active={selectedTaxa.has(tc)}
      onClick={() => filters.setSelectedTaxa((prev) => toggleInSet(prev, tc))}
    >
      {taxonDisplayLabel(tc, facets.namingStyles)}
    </Pill>
  );

  const { ratingMin, ratingMax } = query;
  const animalsMode = query.animalsMin === null ? "" : query.animalsMin === query.animalsMax ? "exactly" : "atLeast";

  return (
    // A line between sections, whichever ones a page shows.
    <div className="space-y-2 [&>*+*]:border-t [&>*+*]:border-line [&>*+*]:pt-2">
      {on.has("animals") && (
        <div>
          <FilterSectionHeading>{t("collection.toolbar.animals")}</FilterSectionHeading>
          <div className="flex max-h-32 flex-wrap gap-1 overflow-y-auto">
            {ALL_TAXON_CLASSES.filter((tc) => !facets.availableTaxa || facets.availableTaxa.has(tc)).map(taxonPill)}
            {facets.otherTaxaClasses.map(taxonPill)}
          </div>
          {selectedTaxa.size > 0 && (
            <Button variant="link" size="sm" onClick={() => filters.setSelectedTaxa(new Set())} className="mt-1">
              {t("collection.toolbar.clearAnimals")}
            </Button>
          )}
        </div>
      )}

      {on.has("species") && species && species.options.length > 1 && (
        <ChecklistField
          {...species}
          heading={<FilterSectionHeading>{t("photoFilters.species.heading")}</FilterSectionHeading>}
          label={t("photoFilters.species.heading")}
          searchLabel={t("photoFilters.species.search")}
          clearLabel={t("photoFilters.species.clear")}
        />
      )}

      {/* The palette's "search this trip/album" scope, for the smart album builder. */}
      {on.has("scope") && (filters.scopeTrip || filters.scopeAlbum) && (
        <div>
          <FilterSectionHeading>{t("gallery.toolbar.searchingIn")}</FilterSectionHeading>
          <div className="flex flex-wrap gap-1.5">
            {filters.scopeTrip && (
              <ScopeChip
                label={t("gallery.scope.trip", { name: filters.scopeTrip.name ?? "" }).trim()}
                onRemove={() => filters.clearScope("trip")}
              />
            )}
            {filters.scopeAlbum && (
              <ScopeChip
                label={t("gallery.scope.album", { name: filters.scopeAlbum.name ?? "" }).trim()}
                onRemove={() => filters.clearScope("album")}
              />
            )}
          </div>
        </div>
      )}

      {on.has("showOnly") && (
        <div>
          <FilterSectionHeading>{t("gallery.toolbar.showOnly")}</FilterSectionHeading>
          <div className="flex flex-wrap items-center gap-3">
            <FilterCheckbox checked={query.onlyFeatured} onChange={filters.setOnlyFeatured}>
              {t("gallery.toolbar.featured")}
            </FilterCheckbox>
            {(inat?.connected || query.notOnInat) && (
              <FilterCheckbox checked={query.notOnInat} onChange={filters.setNotOnInat}>
                {t("gallery.toolbar.notOnInat")}
              </FilterCheckbox>
            )}
            {/* Photos a culling app rejected, imported hidden (docs: Culling with other apps). */}
            {(facets.hiddenCount > 0 || query.onlyHidden) && (
              <FilterCheckbox checked={query.onlyHidden} onChange={filters.setOnlyHidden}>
                {t("gallery.toolbar.hidden")}
              </FilterCheckbox>
            )}
            <FilterCheckbox checked={query.missingDate} onChange={filters.setMissingDate}>
              {t("gallery.toolbar.missingDate")}
            </FilterCheckbox>
            <FilterCheckbox checked={query.missingCoordinates} onChange={filters.setMissingCoordinates}>
              {t("gallery.toolbar.missingCoordinates")}
            </FilterCheckbox>
          </div>
        </div>
      )}

      {on.has("rating") && (
        <div>
          <FilterSectionHeading>{t("gallery.toolbar.rating")}</FilterSectionHeading>
          <StarRangePicker
            value={{ min: ratingMin, max: ratingMax, unrated: query.unrated }}
            onChange={(v) => filters.setRating(v.min, v.max, v.unrated)}
          />
        </div>
      )}

      {on.has("animalCount") && (
        <div>
          <FilterSectionHeading>{t("gallery.toolbar.animalCount")}</FilterSectionHeading>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              aria-label={t("gallery.toolbar.animalCount")}
              value={animalsMode}
              onChange={(e) => {
                const v = e.target.value;
                if (!v) filters.setAnimals(null, false);
                else filters.setAnimals(query.animalsMin ?? (v === "exactly" ? 1 : 2), v === "exactly");
              }}
            >
              <option value="">{t("gallery.toolbar.anyAnimalCount")}</option>
              <option value="exactly">{t("gallery.toolbar.animalCountExactly")}</option>
              <option value="atLeast">{t("gallery.toolbar.animalCountAtLeast")}</option>
            </Select>
            {query.animalsMin !== null && (
              <Select
                aria-label={t("gallery.toolbar.animalCountNumber")}
                value={query.animalsMin}
                onChange={(e) => filters.setAnimals(Number(e.target.value), animalsMode === "exactly")}
              >
                {ANIMAL_COUNTS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            )}
          </div>
        </div>
      )}

      {on.has("rarity") && (
        <div>
          <FilterSectionHeading>
            {tierRegion ? t("gallery.toolbar.tierIn", { region: tierRegion }) : t("gallery.toolbar.tier")}
          </FilterSectionHeading>
          {/* Choices are alternatives: any of the chosen tiers. */}
          <div role="group" aria-label={t("gallery.toolbar.tier")} className="flex flex-wrap gap-1">
            {TIER_ORDER.map((tr) => (
              <Pill
                key={tr}
                size="sm"
                active={tiers.includes(tr)}
                onClick={() => filters.setTiers(toggleInList(tiers, tr))}
              >
                {tierLabel(tr)}
              </Pill>
            ))}
          </div>
        </div>
      )}

      {/* The explicit filter only: a typed "flight" stays a search. */}
      {on.has("shotKind") && (
        <div className="space-y-1.5">
          <FilterSectionHeading>{t("gallery.toolbar.shotKind")}</FilterSectionHeading>
          <ShotTypeGroup
            label={t("gallery.toolbar.shotAction")}
            values={SHOT_ACTIONS}
            labels={SHOT_ACTION_LABELS}
            chosen={filters.shotActions}
            onChange={filters.setShotActions}
          />
          <ShotTypeGroup
            label={t("gallery.toolbar.shotFraming")}
            values={SHOT_FRAMINGS}
            labels={SHOT_FRAMING_LABELS}
            chosen={filters.shotFramings}
            onChange={filters.setShotFramings}
          />
        </div>
      )}

      {on.has("appearance") && <AppearanceFilterField filters={filters} facets={facets} />}

      {on.has("region") && (
        <div>
          <FilterSectionHeading>{t("gallery.toolbar.region")}</FilterSectionHeading>
          <FilterCheckbox
            checked={noRegion}
            onChange={(checked) =>
              filters.setRegionIds(
                checked
                  ? [...regionIds, UNCATEGORIZED_REGION_ID]
                  : regionIds.filter((id) => id !== UNCATEGORIZED_REGION_ID),
              )
            }
          >
            {t("gallery.toolbar.noRegion")}
          </FilterCheckbox>
          <FilterChips
            labels={pickedRegionIds.map((id) => {
              const region = regionsById.get(id);
              return { value: id, label: region ? regionLabel(regionsById, region) : id };
            })}
            onRemove={(id) => filters.setRegionIds(regionIds.filter((r) => r !== id))}
          />
          <div className="mt-1.5">
            <RegionBrowser
              regionId={null}
              onChange={(id) => id && !regionIds.includes(id) && filters.setRegionIds([...regionIds, id])}
              allowAnyRegion
              searchOnly
              restrictToIds={facets.regionsWithPhotos}
            />
          </div>
        </div>
      )}

      {on.has("place") && (
        <div>
          <FilterSectionHeading>{t("captureEdit.location.placeName")}</FilterSectionHeading>
          <FilterChips
            labels={query.places.map((p) => ({ value: p, label: p }))}
            onRemove={(p) => filters.setPlaces(query.places.filter((x) => x !== p))}
          />
          <PlaceNameInput
            id="gallery-place-filter"
            aria-label={t("captureEdit.location.placeName")}
            value={placeDraft}
            onChange={setPlaceDraft}
            onPick={(name) => {
              setPlaceDraft("");
              if (!query.places.includes(name)) filters.setPlaces([...query.places, name]);
            }}
            regionId={soleRegionId(regionIds)}
            onlyInRegion
            size="sm"
          />
        </div>
      )}

      {on.has("tag") && (tagOptions.length > 0 || query.tags.length > 0) && (
        <div>
          <FilterSectionHeading>{t("gallery.toolbar.tag")}</FilterSectionHeading>
          <FilterChips
            labels={query.tags.map((tag) => ({ value: tag, label: tag }))}
            onRemove={(tag) => filters.setTags(query.tags.filter((x) => x !== tag))}
          />
          <Select
            aria-label={t("gallery.toolbar.tag")}
            value=""
            onChange={(e) => e.target.value && filters.setTags([...query.tags, e.target.value])}
          >
            <option value="">
              {query.tags.length > 0 ? t("gallery.toolbar.addTag") : t("gallery.toolbar.anyTag")}
            </option>
            {tagOptions
              .filter((tag) => !query.tags.includes(tag))
              .map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
          </Select>
        </div>
      )}

      {on.has("date") && (
        <div>
          <DateRangeField
            dateFrom={dateFrom}
            dateTo={dateTo}
            onDateFromChange={filters.setDateFrom}
            onDateToChange={filters.setDateTo}
            open={filters.dateRangeOpen}
            onOpen={() => filters.setDateRangeOpen(true)}
            onClear={() => {
              filters.setDateFrom("");
              filters.setDateTo("");
              filters.setDateRangeOpen(false);
            }}
            sectionHeading
          />
        </div>
      )}

      {on.has("media") && (facets.hasOtherMediaInLibrary || query.mediaFilter !== "photos") && (
        <div>
          <MediaFilterField value={query.mediaFilter} onChange={filters.setMediaFilter} sectionHeading />
        </div>
      )}

      {on.has("raw") && (
        <div className="space-y-2">
          <RawFilterFields
            rawFiles={query.rawFiles}
            editedRaw={query.editedRaw}
            onRawFilesChange={filters.setRawFiles}
            onEditedRawChange={filters.setEditedRaw}
            sectionHeading
            withUnedited
          />
        </div>
      )}
    </div>
  );
}

// Picks any number of a list's values (a page's species, the library's morphs). A long list scrolls,
// and past a screenful a search narrows it; picked values stay listed so they can be unpicked.
function ChecklistField({
  options,
  selected,
  onChange,
  heading,
  label,
  searchLabel,
  clearLabel,
}: SpeciesFilterChoices & { heading: ReactNode; label: string; searchLabel: string; clearLabel: string }) {
  const [query, setQuery] = useState("");
  const q = normalizeForSearch(query);
  const shown = q ? options.filter((o) => selected.has(o.id) || normalizeForSearch(o.label).includes(q)) : options;
  return (
    <div>
      {heading}
      {options.length > 8 && (
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder={searchLabel}
          aria-label={searchLabel}
          className="mb-1.5 w-full"
        />
      )}
      <div role="group" aria-label={label} className="max-h-48 space-y-1 overflow-y-auto">
        {shown.map((o) => (
          <FilterCheckbox
            key={o.id}
            checked={selected.has(o.id)}
            onChange={() => onChange(toggleInSet(new Set(selected), o.id))}
          >
            <span className="flex min-w-0 flex-1 gap-2">
              <span className="min-w-0 break-words">{o.label}</span>
              <span className="ml-auto shrink-0 tabular-nums text-muted">{formatNumber(o.count)}</span>
            </span>
          </FilterCheckbox>
        ))}
      </div>
      {selected.size > 0 && (
        <Button variant="link" size="sm" onClick={() => onChange(new Set())} className="mt-1">
          {clearLabel}
        </Button>
      )}
    </div>
  );
}

// Life stage and sex as pills, plumage and morph as checklists with photo counts. Only values the
// library holds are offered (plus any already picked), and the section hides when there are none.
function AppearanceFilterField({ filters, facets }: Pick<FilterFieldsProps, "filters" | "facets">) {
  const { t } = useTranslation();
  const labels = useAppearanceLabels();
  const chosen = filters.query.appearance;
  const held = (kind: AppearanceKind) =>
    new Set([...(facets.appearance?.[kind] ?? []).map((f) => f.value), ...chosen[kind]]);
  const stages = LIFE_STAGES.filter((v) => held("lifeStage").has(v));
  const sexes = SEXES.filter((v) => held("sex").has(v));
  const checklist = (kind: "plumage" | "morph", label: string, searchLabel: string, clearLabel: string) => {
    const counted = facets.appearance?.[kind] ?? [];
    const options = [
      ...chosen[kind].filter((v) => !counted.some((f) => f.value === v)).map((v) => ({ id: v, label: v, count: 0 })),
      ...counted.map((f) => ({ id: f.value, label: f.value, count: f.count })),
    ];
    if (options.length === 0) return null;
    return (
      <ChecklistField
        options={options}
        selected={new Set(chosen[kind])}
        onChange={(next) => filters.setAppearance(kind, [...next])}
        heading={<FilterFieldLabel>{label}</FilterFieldLabel>}
        label={label}
        searchLabel={searchLabel}
        clearLabel={clearLabel}
      />
    );
  };
  const plumage = checklist(
    "plumage",
    t("appearance.plumageLabel"),
    t("photoFilters.appearance.findPlumage"),
    t("photoFilters.appearance.clearPlumage"),
  );
  const morph = checklist(
    "morph",
    t("appearance.morph"),
    t("photoFilters.appearance.findMorph"),
    t("photoFilters.appearance.clearMorph"),
  );
  if (stages.length === 0 && sexes.length === 0 && !plumage && !morph) return null;
  const setStages = (next: string[]) => filters.setAppearance("lifeStage", next);
  const setSexes = (next: string[]) => filters.setAppearance("sex", next);
  return (
    <div className="space-y-1.5">
      <FilterSectionHeading>{t("appearance.title")}</FilterSectionHeading>
      {stages.length > 0 && (
        <PillGroup
          label={t("appearance.lifeStage")}
          values={stages}
          labelOf={labels.stage}
          chosen={chosen.lifeStage}
          onChange={setStages}
        />
      )}
      {sexes.length > 0 && (
        <PillGroup
          label={t("appearance.sexLabel")}
          values={sexes}
          labelOf={labels.sex}
          chosen={chosen.sex}
          onChange={setSexes}
        />
      )}
      {plumage}
      {morph}
    </div>
  );
}

// A labelled row of pills; its choices are alternatives (any of them).
function PillGroup<T extends string>({
  label,
  values,
  labelOf,
  chosen,
  onChange,
}: {
  label: string;
  values: readonly T[];
  labelOf: (v: T) => string;
  chosen: readonly string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div role="group" aria-label={label}>
      <FilterFieldLabel>{label}</FilterFieldLabel>
      <div className="flex flex-wrap gap-1">
        {values.map((v) => (
          <Pill key={v} size="sm" active={chosen.includes(v)} onClick={() => onChange(toggleInList(chosen, v))}>
            {labelOf(v)}
          </Pill>
        ))}
      </div>
    </div>
  );
}

// One axis of the Shot type filter. Its choices are alternatives (any of them); the two axes combine.
function ShotTypeGroup<T extends string>({
  label,
  values,
  labels,
  chosen,
  onChange,
}: {
  label: string;
  values: readonly T[];
  labels: Record<T, string>;
  chosen: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div role="group" aria-label={label}>
      <FilterFieldLabel>{label}</FilterFieldLabel>
      <div className="flex flex-wrap gap-1">
        {values.map((v) => (
          <Pill key={v} size="sm" active={chosen.has(v)} onClick={() => onChange(toggleInSet(new Set(chosen), v))}>
            {t(labels[v])}
          </Pill>
        ))}
      </div>
    </div>
  );
}

// The values chosen for a filter that takes several, each removable. A long list scrolls instead of
// pushing the rest of the menu away.
function FilterChips({
  labels,
  onRemove,
}: {
  labels: ReadonlyArray<{ value: string; label: string }>;
  onRemove: (value: string) => void;
}) {
  if (labels.length === 0) return null;
  return (
    <div className="mb-1.5 mt-1 flex max-h-28 flex-wrap gap-1 overflow-y-auto">
      {labels.map(({ value, label }) => (
        <ScopeChip key={value} label={label} onRemove={() => onRemove(value)} />
      ))}
    </div>
  );
}

// A removable filter chip: an "In trip X" scope from the palette's search-within hand-off, or a
// picked place.
export function ScopeChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-line bg-surface-muted px-2 py-0.5 text-footnote text-ink">
      <span className="min-w-0 truncate" title={label}>
        {label}
      </span>
      <IconButton
        tone="plain"
        onClick={onRemove}
        aria-label={t("gallery.scope.remove", { label })}
        className="h-4! min-w-4! text-callout leading-none"
      >
        ×
      </IconButton>
    </span>
  );
}
