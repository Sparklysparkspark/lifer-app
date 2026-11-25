import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BulkNamesBody } from "../../components/AddOtherTaxaModal";
import { AddSpeciesListBody } from "../../components/AddSpeciesListModal";
import SegmentedControl from "../../components/SegmentedControl";
import SlotModal from "../../components/SlotModal";
import { usePersistedState } from "../../hooks/usePersistedState";
import { useSettings } from "../../hooks/useSettings";
import type { ChecklistTarget } from "../../lib/checklistAdditions";
import AddSpeciesToChecklistBody from "./AddSpeciesToChecklistBody";

export type AddOtherSpeciesTab = "search" | "group" | "paste";

/** Whether Add other species has anything to offer: a search needs a region with a checklist, the
 *  other two tabs need the iNaturalist search setting. */
export function useAddOtherSpeciesTabs(hasChecklist: boolean): AddOtherSpeciesTab[] {
  const inat = !!useSettings().settings?.anyTaxaSearchEnabled;
  return [...(hasChecklist ? ["search" as const] : []), ...(inat ? (["group", "paste"] as const) : [])];
}

/** "Add other species": search for one species, add a group from iNaturalist, or paste a list of
 *  names, in one dialog that remembers the tab last used. */
export default function AddOtherSpeciesModal({
  targets,
  region,
  initialTab,
  onClose,
  onAdded,
}: {
  /** The checklists a searched species can go on; null where the view has none (no search tab). */
  targets: ChecklistTarget[] | null;
  /** The region in view: the default place for a group and the default region for a list of names. */
  region: { id: string; name: string } | null;
  /** Opens on this tab (an empty state's button) instead of the last one used. */
  initialTab?: AddOtherSpeciesTab;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { t } = useTranslation();
  const tabs = useAddOtherSpeciesTabs(!!targets);
  const [last, setLast] = usePersistedState<AddOtherSpeciesTab>("addOtherSpeciesTab", "search");
  const wanted = initialTab ?? last;
  const tab = tabs.includes(wanted) ? wanted : tabs[0];
  const labels: Record<AddOtherSpeciesTab, string> = {
    search: t("addOther.tabSearch"),
    group: t("addOther.tabGroup"),
    paste: t("addOther.tabPaste"),
  };
  // Only a tab the user picks is remembered; the one an empty state opened on stands for this visit.
  const [override, setPicked] = useState<AddOtherSpeciesTab | null>(null);
  const picked = override ?? tab;

  return (
    <SlotModal onClose={onClose} title={t("addOther.title")}>
      {tabs.length > 1 && (
        <div className="mb-3">
          <SegmentedControl
            label={t("addOther.tabsLabel")}
            value={picked}
            onChange={(next) => {
              setPicked(next);
              setLast(next);
            }}
            options={tabs.map((value) => ({ value, label: labels[value] }))}
          />
        </div>
      )}
      {picked === "search" && targets && (
        <AddSpeciesToChecklistBody targets={targets} onClose={onClose} onAdded={onAdded} />
      )}
      {picked === "group" && <AddSpeciesListBody regionId={region?.id} regionName={region?.name} onClose={onClose} />}
      {picked === "paste" && <BulkNamesBody initialRegionId={region?.id} onClose={onClose} />}
    </SlotModal>
  );
}
