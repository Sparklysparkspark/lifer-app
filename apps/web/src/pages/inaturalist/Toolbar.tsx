// The iNaturalist tabs' toolbar, the same shape as the Collection's: search, Select, View and
// Filters, from the same shared controls.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import Button from "../../components/Button";
import FilterPopover, { FilterSectionHeading } from "../../components/FilterPopover";
import Menu, { MenuItems, MenuPanel } from "../../components/Menu";
import Pill from "../../components/Pill";
import SearchInput from "../../components/SearchInput";
import Select from "../../components/Select";
import { PhotoViewMenu } from "../../components/PhotoGridControls";
import { useDropdownMenu } from "../../hooks/useDropdownMenu";
import { useSettings } from "../../hooks/useSettings";
import { taxonFilterLabel } from "../collection/taxonLabels";
import { CARD_MAX, CARD_MIN, GROUPS, SORTS, SORTS_GROUPED, type useInatView } from "./viewPrefs";

/** One choice in the Filters panel: a heading and a full-width select. */
export function FilterSelect<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
}) {
  return (
    <div>
      <FilterSectionHeading>{label}</FilterSectionHeading>
      <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)} className="w-full">
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

/** Group of life pills, like the Collection's: only the groups present, any number at once. */
export function TaxonFilter({
  available,
  selected,
  onChange,
}: {
  available: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const namingStyles = settings?.speciesNamingStyles ?? [];
  if (available.length < 2 && selected.size === 0) return null;
  return (
    <div className="border-t border-line pt-2">
      <FilterSectionHeading>{t("inaturalist.toolbar.taxon")}</FilterSectionHeading>
      <div className="flex max-h-56 flex-wrap gap-1 overflow-y-auto">
        {available.map((taxon) => (
          <Pill
            key={taxon}
            size="sm"
            active={selected.has(taxon)}
            onClick={() => {
              const next = new Set(selected);
              if (!next.delete(taxon)) next.add(taxon);
              onChange(next);
            }}
          >
            {taxonFilterLabel(taxon, namingStyles)}
          </Pill>
        ))}
      </div>
    </div>
  );
}

export function InatToolbar({
  search,
  onSearch,
  shownCount,
  selectedCount,
  selectAllLabel,
  onSelectAll,
  onSelectNone,
  selecting,
  onSelecting,
  view,
  filterCount,
  onClearFilters,
  filters,
}: {
  search: string;
  onSearch: (value: string) => void;
  /** How many cards are listed, for Select all. */
  shownCount: number;
  selectedCount: number;
  /** "Select every sighting", or the tab's own word. */
  selectAllLabel: string;
  onSelectAll: () => void;
  onSelectNone: () => void;
  /** Select mode: cards show their tick and a click toggles them. */
  selecting: boolean;
  onSelecting: (on: boolean) => void;
  view: ReturnType<typeof useInatView>;
  filterCount: number;
  onClearFilters: () => void;
  filters: ReactNode;
}) {
  const { t } = useTranslation();
  const menu = useDropdownMenu();
  return (
    <div className="flex flex-wrap items-center gap-3 text-footnote">
      <SearchInput
        value={search}
        onChange={onSearch}
        placeholder={t("inaturalist.import.search")}
        aria-label={t("inaturalist.import.search")}
        className="w-60 max-w-full"
      />
      {/* Like the Gallery: Select enters select mode; there, this menu has select all and none. */}
      {!selecting ? (
        <Button variant="secondary" size="sm" disabled={shownCount === 0} onClick={() => onSelecting(true)}>
          {t("ui.select")}
        </Button>
      ) : (
        <>
          <Menu
            open={menu.openKey !== null}
            onToggle={() => menu.setOpenKey(menu.openKey ? null : true)}
            menuRef={menu.ref}
            className="relative"
            trigger={(props) => (
              <Button {...props} variant="secondary" size="sm">
                {t("ui.select")}
              </Button>
            )}
          >
            <MenuPanel>
              <MenuItems
                items={[
                  { label: `${selectAllLabel} (${shownCount})`, onSelect: onSelectAll, disabled: shownCount === 0 },
                  { label: t("inaturalist.toolbar.selectNone"), onSelect: onSelectNone, disabled: selectedCount === 0 },
                ]}
              />
            </MenuPanel>
          </Menu>
          <Button variant="secondary" size="sm" onClick={() => onSelecting(false)}>
            {t("common.done")}
          </Button>
        </>
      )}
      <PhotoViewMenu
        sections={["group", "sort", "size"]}
        activeCount={(view.groupBy !== "none" ? 1 : 0) + (view.sort !== "newest" ? 1 : 0)}
        group={{ value: view.groupBy, options: GROUPS, onChange: view.setGroupBy }}
        sort={{
          value: view.sort,
          options: view.groupBy === "species" ? SORTS_GROUPED : SORTS,
          onChange: view.setSort,
        }}
        size={{
          value: view.cardSize,
          min: CARD_MIN,
          max: CARD_MAX,
          step: 10,
          onChange: view.setCardSize,
          label: t("inaturalist.toolbar.cardSize"),
        }}
      />
      <FilterPopover label={t("inaturalist.toolbar.filters")} activeCount={filterCount}>
        {filters}
        {filterCount > 0 && (
          <div className="border-t border-line pt-2">
            <Button variant="link" size="sm" onClick={onClearFilters}>
              {t("inaturalist.toolbar.clearFilters")}
            </Button>
          </div>
        )}
      </FilterPopover>
    </div>
  );
}
