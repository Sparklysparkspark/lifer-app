// The View menu and filter fields the grids share (Gallery, Collection, trips, albums, species
// pages), so the same choice looks and reads the same on every page.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import Checkbox from "./Checkbox";
import Button from "./Button";
import Select from "./Select";
import Slider from "./Slider";
import SegmentedControl from "./SegmentedControl";
import FilterPopover, { FilterFieldLabel, FilterSectionHeading } from "./FilterPopover";
import type { PhotoCaptionPrefs } from "../hooks/usePhotoCaptionPrefs";
import {
  GROUP_LABEL_KEYS,
  SORT_LABEL_KEYS,
  type GroupOption,
  type SortOption,
  type ViewSection,
} from "../lib/photoGridSections";

import type { EditedRawFilter, MediaFilter, RawFilesFilter } from "../lib/photoListFilters";
import TextField from "./TextField";
import { FIELD, FIELD_HEIGHT } from "../lib/fieldClasses";

const RAW_FILES_OPTIONS: ReadonlyArray<{ value: RawFilesFilter; labelKey: string }> = [
  { value: "show", labelKey: "photoFilters.rawFiles.show" },
  { value: "hide", labelKey: "photoFilters.rawFiles.hide" },
  { value: "only", labelKey: "photoFilters.rawFiles.only" },
  { value: "unedited", labelKey: "photoFilters.rawFiles.unedited" },
];

const EDITED_RAW_OPTIONS: ReadonlyArray<{ value: EditedRawFilter; labelKey: string }> = [
  { value: "any", labelKey: "photoFilters.editedRaw.any" },
  { value: "with", labelKey: "photoFilters.editedRaw.with" },
  { value: "without", labelKey: "photoFilters.editedRaw.without" },
];

const MEDIA_OPTIONS: ReadonlyArray<{ value: MediaFilter; labelKey: string }> = [
  { value: "both", labelKey: "photoFilters.media.both" },
  { value: "photos", labelKey: "photoFilters.media.photos" },
  { value: "videos", labelKey: "photoFilters.media.videos" },
  { value: "recordings", labelKey: "photoFilters.media.recordings" },
];

export type PhotoLayout = "grid" | "map";

interface ViewChoice<T extends string> {
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
  disabled?: boolean;
  title?: string;
}

// Generic in the page's own sort and group types, so its setters fit as they are.
export interface PhotoViewMenuProps<S extends SortOption = SortOption, G extends GroupOption = GroupOption> {
  /** Which sections this page has. Each renders the same way on every page. */
  sections: readonly ViewSection[];
  /** Choices off their default, e.g. a sort other than newest. */
  activeCount: number;
  /** `menuOpen` keeps the menu open on a page that renders a different toolbar per view. */
  show?: {
    value: "gallery" | "species";
    onChange(value: "gallery" | "species"): void;
    menuOpen?: boolean;
    onMenuOpenChange?(open: boolean): void;
  };
  /** The photos as a grid, or on a map of where they were taken. */
  layout?: { value: PhotoLayout; onChange(value: PhotoLayout): void };
  group?: ViewChoice<G>;
  sort?: ViewChoice<S>;
  /** The photo thumbnail range unless min, max and label say otherwise. */
  size?: {
    value: number;
    onChange: (value: number) => void;
    min?: number;
    max?: number;
    step?: number;
    label?: string;
    valueText?: string;
    disabled?: boolean;
  };
  captions?: PhotoCaptionPrefs;
  /** Checkboxes that move some cards to the front ("Photographed first"). */
  order?: ReadonlyArray<{
    key: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
    label: string;
    title?: string;
  }>;
  hideNames?: { checked: boolean; onChange: (checked: boolean) => void };
  /** Pins on the region map where each species was photographed. */
  mapPins?: { checked: boolean; onChange: (checked: boolean) => void };
  /** Every version of a photo (prints, edits, exports) as its own item. */
  allVersions?: { checked: boolean; onChange: (checked: boolean) => void };
  /** Each burst as one stack tile, its best-rated or first photo with the count. */
  groupBursts?: { checked: boolean; onChange: (checked: boolean) => void };
  /** Which photos count toward a card, as radio choices. */
  counting?: {
    value: string;
    options: ReadonlyArray<{ value: string; label: string }>;
    onChange(value: string): void;
  };
}

/** The View menu every grid shares: how the page lays out what it shows, apart from which items
 *  show (Filters). A page lists its sections and passes each one's state. */
export function PhotoViewMenu<S extends SortOption, G extends GroupOption>({
  sections,
  activeCount,
  show,
  layout,
  group,
  sort,
  size,
  captions,
  order,
  hideNames,
  mapPins,
  allVersions,
  groupBursts,
  counting,
}: PhotoViewMenuProps<S, G>) {
  const { t } = useTranslation();
  const on = new Set<ViewSection>(sections);
  const showGroup = on.has("group") && group;
  const showSort = on.has("sort") && sort;
  const showSize = on.has("size") && size;
  const showOrder = on.has("order") && order;
  const showHideNames = on.has("hideNames") && hideNames;
  const showMapPins = on.has("mapPins") && mapPins;
  const showAllVersions = on.has("versions") && allVersions;
  const showGroupBursts = on.has("bursts") && groupBursts;
  const showCounting = on.has("counting") && counting;
  return (
    <FilterPopover
      label={t("collection.toolbar.view")}
      activeCount={activeCount}
      open={show?.menuOpen}
      onOpenChange={show?.onMenuOpenChange}
    >
      {on.has("show") && show && <ShowField view={show.value} onChange={show.onChange} />}
      {on.has("layout") && layout && (
        <div role="group" aria-label={t("photoFilters.view.layout")}>
          <FilterSectionHeading>{t("photoFilters.view.layout")}</FilterSectionHeading>
          <SegmentedControl
            value={layout.value}
            onChange={layout.onChange}
            options={[
              { value: "grid", label: t("photoFilters.view.grid") },
              { value: "map", label: t("photoFilters.view.map") },
            ]}
          />
        </div>
      )}
      {(showGroup || showSort || showSize) && (
        <div>
          <FilterSectionHeading>{t("collection.toolbar.arrange")}</FilterSectionHeading>
          {/* Labels in one column and controls in the next, so the controls line up. */}
          <div className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-footnote text-muted">
            {showGroup && (
              <Select
                label={t("collection.toolbar.group")}
                labelClassName="contents"
                className="w-full"
                value={group.value}
                disabled={group.disabled}
                title={group.title}
                onChange={(e) => group.onChange(e.target.value as G)}
              >
                {group.options.map((o) => (
                  <option key={o} value={o}>
                    {t(GROUP_LABEL_KEYS[o])}
                  </option>
                ))}
              </Select>
            )}
            {showSort && (
              <Select
                label={t("photoFilters.sort.label")}
                labelClassName="contents"
                className="w-full"
                value={sort.value}
                disabled={sort.disabled}
                title={sort.title}
                onChange={(e) => sort.onChange(e.target.value as S)}
              >
                {sort.options.map((o) => (
                  <option key={o} value={o}>
                    {t(SORT_LABEL_KEYS[o])}
                  </option>
                ))}
              </Select>
            )}
            {showSize && (
              <label className="contents">
                {t("photoFilters.size")}
                <Slider
                  min={size.min ?? 120}
                  max={size.max ?? 800}
                  step={size.step ?? 20}
                  value={size.value}
                  disabled={size.disabled}
                  onChange={size.onChange}
                  aria-label={size.label ?? t("photoFilters.sizeLabel")}
                  valueText={size.valueText}
                />
              </label>
            )}
          </div>
        </div>
      )}
      {on.has("captions") && captions && (
        <div className="space-y-1.5">
          <PhotoCaptionOptions prefs={captions} />
        </div>
      )}
      {(showOrder || showHideNames || showMapPins || showAllVersions || showGroupBursts) && (
        <div className="space-y-1.5">
          {showOrder &&
            order.map((o) => (
              <FilterCheckbox key={o.key} checked={o.checked} onChange={o.onChange} title={o.title}>
                {o.label}
              </FilterCheckbox>
            ))}
          {/* The quick "just photos" switch; badges and name styles are in Settings. */}
          {showHideNames && (
            <FilterCheckbox checked={hideNames.checked} onChange={hideNames.onChange}>
              {t("collection.toolbar.hideNames")}
            </FilterCheckbox>
          )}
          {showMapPins && (
            <FilterCheckbox checked={mapPins.checked} onChange={mapPins.onChange}>
              {t("collection.toolbar.showMapPins")}
            </FilterCheckbox>
          )}
          {showAllVersions && (
            <FilterCheckbox checked={allVersions.checked} onChange={allVersions.onChange}>
              {t("versions.showAll")}
            </FilterCheckbox>
          )}
          {showGroupBursts && (
            <FilterCheckbox checked={groupBursts.checked} onChange={groupBursts.onChange}>
              {t("bursts.groupOption")}
            </FilterCheckbox>
          )}
        </div>
      )}
      {showCounting && (
        <div className="border-t border-line pt-2">
          <FilterSectionHeading>{t("collection.toolbar.counting")}</FilterSectionHeading>
          <div className="grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2 text-footnote text-muted">
            <RadioGroup
              legend={t("collection.toolbar.countPhotosFrom")}
              name="photographed-in"
              value={counting.value}
              options={counting.options}
              onChange={counting.onChange}
            />
          </div>
        </div>
      )}
      {on.has("nameSettings") && (
        <div className="border-t border-line pt-2">
          <Link to="/settings/general" className="text-footnote text-muted hover:underline">
            {t("collection.toolbar.nameSettings")}
          </Link>
        </div>
      )}
    </FilterPopover>
  );
}

// Two cells of a label/control grid: the group's name, then its options. `stacked` lists the
// options one per line under the name instead.
export function RadioGroup({
  legend,
  name,
  value,
  options,
  onChange,
  stacked,
}: {
  legend: string;
  name: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
  stacked?: boolean;
}) {
  const labelId = `${name}-label`;
  return (
    <>
      <span id={labelId} className={stacked ? "text-footnote font-semibold text-ink" : undefined}>
        {legend}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className={stacked ? "mt-1.5 flex flex-col gap-1.5" : "flex flex-wrap gap-x-3 gap-y-1"}
      >
        {options.map((o) => (
          <label key={o.value} className="flex items-center gap-1.5 text-ink">
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
              className="accent-accent"
            />
            {o.label}
          </label>
        ))}
      </div>
    </>
  );
}

/** The caption choices under photo tiles, the same three on every page. */
export function PhotoCaptionOptions({ prefs }: { prefs: PhotoCaptionPrefs }) {
  const { t } = useTranslation();
  return (
    <>
      <FilterCheckbox checked={prefs.showLabels} onChange={prefs.setShowLabels}>
        {t("photoFilters.display.labels")}
      </FilterCheckbox>
      <FilterCheckbox checked={prefs.showCameraInfo} onChange={prefs.setShowCameraInfo}>
        {t("photoFilters.display.cameraInfo")}
      </FilterCheckbox>
      <FilterCheckbox checked={prefs.showRatings} onChange={prefs.setShowRatings}>
        {t("photoFilters.display.ratings")}
      </FilterCheckbox>
    </>
  );
}

/** A checkbox row in a View or Filters menu ("Featured", "Labels"...). */
export function FilterCheckbox({
  checked,
  onChange,
  title,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title?: string;
  children: ReactNode;
}) {
  return (
    <Checkbox size="sm" checked={checked} onChange={onChange} title={title}>
      {children}
    </Checkbox>
  );
}

// The heading above a pill row is only a <p>, so the row names itself as a group.
/** RAW-only photos: shown, hidden or alone, and edited photos by whether they have a RAW. */
export function RawFilterFields({
  rawFiles,
  editedRaw,
  onRawFilesChange,
  onEditedRawChange,
  sectionHeading,
  withUnedited,
}: {
  rawFiles: RawFilesFilter;
  editedRaw: EditedRawFilter;
  onRawFilesChange: (value: RawFilesFilter) => void;
  onEditedRawChange: (value: EditedRawFilter) => void;
  /** Titled as its own section, in a popover with several. */
  sectionHeading?: boolean;
  /** Offers "Not edited yet", the editing backlog, where the server can answer it. */
  withUnedited?: boolean;
}) {
  const { t } = useTranslation();
  const Label = sectionHeading ? FilterSectionHeading : FilterFieldLabel;
  const options = withUnedited ? RAW_FILES_OPTIONS : RAW_FILES_OPTIONS.filter((o) => o.value !== "unedited");
  return (
    <>
      <div role="group" aria-label={t("photoFilters.rawFiles.label")}>
        <Label>{t("photoFilters.rawFiles.label")}</Label>
        <SegmentedControl
          value={rawFiles}
          onChange={onRawFilesChange}
          options={options.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
        />
        {rawFiles === "unedited" && (
          <p className="mt-1 text-footnote text-muted">{t("photoFilters.rawFiles.uneditedHint")}</p>
        )}
      </div>
      <div role="group" aria-label={t("photoFilters.editedRaw.label")}>
        <Label>{t("photoFilters.editedRaw.label")}</Label>
        <SegmentedControl
          value={editedRaw}
          onChange={onEditedRawChange}
          options={EDITED_RAW_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
        />
      </div>
    </>
  );
}

export function MediaFilterField({
  value,
  onChange,
  sectionHeading,
}: {
  value: MediaFilter;
  onChange: (value: MediaFilter) => void;
  /** Titled as its own section, in a popover with several. */
  sectionHeading?: boolean;
}) {
  const { t } = useTranslation();
  const Label = sectionHeading ? FilterSectionHeading : FilterFieldLabel;
  return (
    <div role="group" aria-label={t("photoFilters.media.label")}>
      <Label>{t("photoFilters.media.label")}</Label>
      <SegmentedControl
        value={value}
        onChange={onChange}
        options={MEDIA_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
      />
    </div>
  );
}

/** "Any date" until opened, then a from/to pair. With `onClear`, a set range gets a Clear link. */
export function DateRangeField({
  dateFrom,
  dateTo,
  onDateFromChange,
  onDateToChange,
  open,
  onOpen,
  onClear,
  sectionHeading,
}: {
  dateFrom: string;
  dateTo: string;
  onDateFromChange: (value: string) => void;
  onDateToChange: (value: string) => void;
  open: boolean;
  onOpen: () => void;
  onClear?: () => void;
  /** Titled as its own section, in a popover with several. */
  sectionHeading?: boolean;
}) {
  const { t } = useTranslation();
  const Label = sectionHeading ? FilterSectionHeading : FilterFieldLabel;
  return (
    <div>
      <Label>{t("photoFilters.date.label")}</Label>
      {open || dateFrom || dateTo ? (
        <div className="flex items-center gap-1.5">
          {/* An unset date is muted: WebKit shows today's date as its placeholder. */}
          <TextField
            type="date"
            value={dateFrom}
            max={dateTo || undefined}
            onChange={(e) => onDateFromChange(e.target.value)}
            size="sm"
            className={dateFrom ? "" : "text-muted!"}
            aria-label={t("photoFilters.date.from")}
          />
          <span className="text-footnote text-muted">{t("photoFilters.date.to")}</span>
          <TextField
            type="date"
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(e) => onDateToChange(e.target.value)}
            size="sm"
            className={dateTo ? "" : "text-muted!"}
            aria-label={t("photoFilters.date.toLabel")}
          />
          {onClear && (dateFrom || dateTo) && (
            <Button variant="link" size="sm" onClick={onClear} className="shrink-0">
              {t("photoFilters.date.clear")}
            </Button>
          )}
        </div>
      ) : (
        // Looks like the date fields it opens into, so it reads as an empty field, not an action.
        <button type="button" onClick={onOpen} className={`${FIELD} ${FIELD_HEIGHT.sm} text-left text-muted!`}>
          {t("photoFilters.date.any")}
        </button>
      )}
    </div>
  );
}

/** The View menu's top section on trip and album pages: their photos, or the species in them. */
export function ShowField({
  view,
  onChange,
}: {
  view: "gallery" | "species";
  onChange: (view: "gallery" | "species") => void;
}) {
  const { t } = useTranslation();
  return (
    <div role="group" aria-label={t("photoFilters.view.show")}>
      <FilterSectionHeading>{t("photoFilters.view.show")}</FilterSectionHeading>
      <SegmentedControl
        value={view}
        onChange={onChange}
        options={[
          { value: "gallery", label: t("photoFilters.view.photos") },
          { value: "species", label: t("photoFilters.view.species") },
        ]}
      />
    </div>
  );
}
