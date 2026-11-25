import { useState } from "react";
import { useTranslation } from "react-i18next";
import SegmentedControl from "./SegmentedControl";
import SlotModal from "./SlotModal";
import TargetGroupBody from "./TargetGroupBody";
import TargetListImportBody from "./TargetListImportBody";

export type AddTargetsTab = "group" | "import";

/** "Add targets": target a group by name, or import a CSV list. Shared by the Collection's Add
 *  species menu and Settings. */
export default function AddTargetsModal({
  regionId = null,
  regionName = null,
  initialTab = "group",
  onClose,
  onChanged,
}: {
  /** The region being browsed: the default place, and its lists come first. */
  regionId?: string | null;
  regionName?: string | null;
  initialTab?: AddTargetsTab;
  onClose: () => void;
  /** After targets were added or taken back. */
  onChanged?: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<AddTargetsTab>(initialTab);
  return (
    <SlotModal onClose={onClose} title={t("targetLists.addTitle")}>
      <div className="mb-3">
        <SegmentedControl
          label={t("targetLists.tabsLabel")}
          value={tab}
          onChange={setTab}
          options={[
            { value: "group", label: t("targetLists.tabGroup") },
            { value: "import", label: t("targetLists.tabImport") },
          ]}
        />
      </div>
      {tab === "group" ? (
        <TargetGroupBody regionId={regionId} regionName={regionName} onClose={onClose} onChanged={onChanged} />
      ) : (
        <TargetListImportBody regionId={regionId} onClose={onClose} onImported={onChanged} />
      )}
    </SlotModal>
  );
}
