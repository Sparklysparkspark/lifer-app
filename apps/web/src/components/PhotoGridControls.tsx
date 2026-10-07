// Toolbar and filter-panel controls the photo grids share (Gallery, trips, albums, species pages),
// so the same choice looks and reads the same on every page.
import type { ReactNode } from "react";
import Select from "./Select";
import SegmentedControl from "./SegmentedControl";
import { FilterFieldLabel } from "./FilterPopover";
import type { MediaFilter, PhotoSort, RawFilter } from "../lib/photoListFilters";

const RAW_OPTIONS: ReadonlyArray<{ value: RawFilter; label: string }> = [
  { value: "any", label: "Any" },
  { value: "with", label: "With" },
  { value: "without", label: "Without" },
];

const MEDIA_OPTIONS: ReadonlyArray<{ value: MediaFilter; label: string }> = [
  { value: "both", label: "Both" },
  { value: "photos", label: "Photos" },
  { value: "videos", label: "Videos" },
];

const VIEW_BUTTON = "px-3 py-1.5";
const VIEW_ACTIVE = "bg-accent text-accent-fg";
const VIEW_INACTIVE = "text-muted hover:bg-surface-muted";

export function PhotoSortSelect({
  value,
  onChange,
  disabled,
  title,
}: {
  value: PhotoSort;
  onChange: (value: PhotoSort) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <Select
      label="Sort"
      value={value}
      onChange={(e) => onChange(e.target.value as PhotoSort)}
      disabled={disabled}
      title={title}
    >
      <option value="newest">Newest first</option>
      <option value="oldest">Oldest first</option>
      <option value="ratingHigh">Highest rated first</option>
      <option value="ratingLow">Lowest rated first</option>
    </Select>
  );
}

export function ThumbSizeSlider({ value, onChange }: { value: number; onChange: (px: number) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted">
      Size
      <input
        type="range"
        min={120}
        max={800}
        step={20}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-24 accent-ink"
        aria-label="Photo grid thumbnail size"
      />
    </label>
  );
}

/** A checkbox row in the Filters panel ("Top rated", "Labels"...). */
export function FilterCheckbox({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-ink">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-ink" />
      {children}
    </label>
  );
}

// The heading above a pill row is only a <p>, so the row names itself as a group.
export function RawFilterField({ value, onChange }: { value: RawFilter; onChange: (value: RawFilter) => void }) {
  return (
    <div role="group" aria-label="RAW files">
      <FilterFieldLabel>RAW files</FilterFieldLabel>
      <SegmentedControl value={value} onChange={onChange} options={RAW_OPTIONS} />
    </div>
  );
}

export function MediaFilterField({ value, onChange }: { value: MediaFilter; onChange: (value: MediaFilter) => void }) {
  return (
    <div role="group" aria-label="Media type">
      <FilterFieldLabel>Media type</FilterFieldLabel>
      <SegmentedControl value={value} onChange={onChange} options={MEDIA_OPTIONS} />
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
}: {
  dateFrom: string;
  dateTo: string;
  onDateFromChange: (value: string) => void;
  onDateToChange: (value: string) => void;
  open: boolean;
  onOpen: () => void;
  onClear?: () => void;
}) {
  return (
    <div>
      <FilterFieldLabel>Date</FilterFieldLabel>
      {open || dateFrom || dateTo ? (
        <div className="flex items-center gap-1.5">
          <input
            type="date"
            value={dateFrom}
            max={dateTo || undefined}
            onChange={(e) => onDateFromChange(e.target.value)}
            className="w-full rounded-md border border-line px-1.5 py-1 text-xs text-ink"
            aria-label="From date"
          />
          <span className="text-xs text-muted">to</span>
          <input
            type="date"
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(e) => onDateToChange(e.target.value)}
            className="w-full rounded-md border border-line px-1.5 py-1 text-xs text-ink"
            aria-label="To date"
          />
          {onClear && (dateFrom || dateTo) && (
            <button onClick={onClear} className="shrink-0 text-[11px] text-muted hover:underline">
              Clear
            </button>
          )}
        </div>
      ) : (
        <button
          onClick={onOpen}
          className="w-full rounded-md border border-line px-1.5 py-1 text-left text-xs text-muted hover:bg-surface-muted"
        >
          Any date
        </button>
      )}
    </div>
  );
}

/** The Gallery / Species view switch on trip and album pages. */
export function GridViewToggle({
  view,
  onChange,
}: {
  view: "gallery" | "species";
  onChange: (view: "gallery" | "species") => void;
}) {
  return (
    <div className="flex rounded-md border border-line text-sm">
      <button
        onClick={() => onChange("gallery")}
        className={`rounded-l-md ${VIEW_BUTTON} ${view === "gallery" ? VIEW_ACTIVE : VIEW_INACTIVE}`}
      >
        Gallery
      </button>
      <button
        onClick={() => onChange("species")}
        className={`rounded-r-md ${VIEW_BUTTON} ${view === "species" ? VIEW_ACTIVE : VIEW_INACTIVE}`}
      >
        Species view
      </button>
    </div>
  );
}
