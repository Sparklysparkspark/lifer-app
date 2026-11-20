import { TAXON_GROUPS, GROUPED_TAXON_CLASSES, taxonDisplayLabel } from "@lifer/shared";
import { useTranslation } from "react-i18next";
import Pill from "../../components/Pill";
import Panel from "../../components/Panel";
import Button from "../../components/Button";
import type { useOfflinePackSelection } from "./useOfflinePackSelection";

// The animal groups to download, applied across every selected country.
export default function TaxonPicker({
  selection,
  namingStyles,
}: {
  selection: ReturnType<typeof useOfflinePackSelection>;
  namingStyles: string[];
}) {
  const { t } = useTranslation();
  const { selectedCountryIds, selectedTaxa, setSelectedTaxa, openTaxonGroups, availableTaxaForSelection, toggleTaxon } =
    selection;
  return (
    <Panel>
      <div className="flex items-center justify-between">
        <p className="text-callout font-semibold text-ink">
          {t("offlinePacks.taxonPicker.title", { count: selectedCountryIds.size })}
        </p>
        {availableTaxaForSelection.length > 0 && (
          <Button
            variant="link"
            size="sm"
            onClick={() =>
              setSelectedTaxa(
                availableTaxaForSelection.every((taxon) => selectedTaxa.has(taxon))
                  ? new Set()
                  : new Set(availableTaxaForSelection),
              )
            }
          >
            {availableTaxaForSelection.every((taxon) => selectedTaxa.has(taxon))
              ? t("offlinePacks.downloaded.deselectAll")
              : t("offlinePacks.downloaded.selectAll")}
          </Button>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {availableTaxaForSelection.length === 0 && (
          <p className="text-footnote text-muted">
            {t("offlinePacks.taxonPicker.noData", { count: selectedCountryIds.size })}
          </p>
        )}
        {availableTaxaForSelection
          .filter((taxon) => !GROUPED_TAXON_CLASSES.has(taxon))
          .map((taxon) => {
            const isSelected = selectedTaxa.has(taxon);
            return (
              <Pill key={taxon} active={isSelected} onClick={() => toggleTaxon(taxon)}>
                {taxonDisplayLabel(taxon, namingStyles)}
              </Pill>
            );
          })}
      </div>
      {/* A group is only a disclosure: each audience (shells, molluscs, ...) picks its own taxa. */}
      {TAXON_GROUPS.map((group) => {
        const availableInGroup = group.taxa.filter((taxon) => availableTaxaForSelection.includes(taxon));
        if (availableInGroup.length === 0) return null;
        const selectedCount = availableInGroup.filter((taxon) => selectedTaxa.has(taxon)).length;
        const isOpen = openTaxonGroups.has(group.key);
        const allInGroupSelected = availableInGroup.every((taxon) => selectedTaxa.has(taxon));
        return (
          <div key={group.key} className="mt-2 border-t border-line pt-2">
            <div className="flex w-full items-center justify-between gap-2">
              {/* raw-control: the group's whole header row is its disclosure toggle */}
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => selection.toggleTaxonGroup(group.key)}
                className="flex flex-1 items-center justify-between text-footnote font-medium text-ink"
              >
                <span>
                  {t("offlinePacks.taxonPicker.groupCount", {
                    group: group.label,
                    selected: selectedCount,
                    total: availableInGroup.length,
                  })}
                </span>
                <span className="text-muted">{isOpen ? "▾" : "▸"}</span>
              </button>
              <Button
                variant="link"
                size="sm"
                onClick={() => selection.toggleAllTaxa(availableInGroup)}
                className="shrink-0"
              >
                {allInGroupSelected ? t("offlinePacks.downloaded.deselectAll") : t("offlinePacks.downloaded.selectAll")}
              </Button>
            </div>
            {isOpen && (
              <div className="mt-2 flex flex-wrap gap-2">
                {availableInGroup.map((taxon) => {
                  const isSelected = selectedTaxa.has(taxon);
                  return (
                    <Pill key={taxon} active={isSelected} onClick={() => toggleTaxon(taxon)}>
                      {taxonDisplayLabel(taxon, namingStyles)}
                    </Pill>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </Panel>
  );
}
