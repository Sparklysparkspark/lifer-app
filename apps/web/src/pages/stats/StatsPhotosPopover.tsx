// The Stats header's one "Photos" control: which keepers to count, and whether RAW-only photos
// count, with a live line saying what is being counted.
import { useTranslation } from "react-i18next";
import FilterPopover from "../../components/FilterPopover";
import { RadioGroup } from "../../components/PhotoGridControls";
import Switch from "../../components/Switch";
import { formatNumber } from "../../lib/format";
import type { PhotoFilter } from "./types";

const OPTIONS: ReadonlyArray<{ value: PhotoFilter; label: string }> = [
  { value: "all", label: "stats.filter.all" },
  { value: "featured", label: "stats.filter.featured" },
  { value: "topRated", label: "stats.filter.topRated" },
];

export default function StatsPhotosPopover({
  filter,
  onFilterChange,
  includeRaw,
  onIncludeRawChange,
  counted,
}: {
  filter: PhotoFilter;
  onFilterChange: (filter: PhotoFilter) => void;
  includeRaw: boolean;
  onIncludeRawChange: (includeRaw: boolean) => void;
  /** Photos the current choices count. */
  counted: number;
}) {
  const { t } = useTranslation();
  const choice = t(OPTIONS.find((o) => o.value === filter)?.label ?? OPTIONS[0].label);
  const countArgs = { count: counted, formatted: formatNumber(counted) };
  return (
    <FilterPopover
      activeCount={0}
      active={filter !== "all" || !includeRaw}
      label={t("stats.photos.button", { choice })}
    >
      <div className="text-callout">
        <RadioGroup
          stacked
          legend={t("stats.photos.count")}
          name="stats-photos-count"
          value={filter}
          options={OPTIONS.map((o) => ({ value: o.value, label: t(o.label) }))}
          onChange={(v) => onFilterChange(v as PhotoFilter)}
        />
      </div>
      <div className="flex items-start justify-between gap-4 border-t border-line pt-3">
        <div className="min-w-0">
          <p className="text-callout text-ink">{t("stats.filter.includeRaw")}</p>
          <p className="text-footnote text-muted">{t("stats.photos.rawDescription")}</p>
        </div>
        <Switch checked={includeRaw} onChange={onIncludeRawChange} label={t("stats.filter.includeRaw")} />
      </div>
      <p className="border-t border-line pt-3 text-footnote text-muted" aria-live="polite">
        {t(includeRaw ? "stats.photos.summaryRaw" : "stats.photos.summaryEdited", countArgs)}
      </p>
    </FilterPopover>
  );
}
