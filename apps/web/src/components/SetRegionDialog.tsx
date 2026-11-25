import { useState } from "react";
import { useTranslation } from "react-i18next";
import RegionBrowser from "./RegionBrowser";
import PlaceNameInput from "./PlaceNameInput";
import Modal from "./Modal";
import Button from "./Button";

/** Same region picker as a photo's location editor, for several photos at once. */
export default function SetRegionDialog({
  count,
  onSet,
  onClose,
  suggestedRegionIds,
}: {
  count: number;
  onSet: (regionId: string, locationLabel: string) => Promise<void>;
  onClose: () => void;
  suggestedRegionIds: Array<string | null | undefined>;
}) {
  const { t } = useTranslation();
  const [regionId, setRegionId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  return (
    <Modal
      open
      onClose={onClose}
      title={t("gallery.select.setRegionTitle", { count })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!regionId}
            onClick={() => {
              if (regionId) void onSet(regionId, label);
              onClose();
            }}
          >
            {t("gallery.select.setRegionApply")}
          </Button>
        </>
      }
    >
      <RegionBrowser
        regionId={regionId}
        onChange={setRegionId}
        allowAnyRegion
        suggestedRegionIds={suggestedRegionIds}
      />
      <div className="mt-4 text-callout">
        <label htmlFor="bulk-place-name" className="mb-1 block text-muted">
          {t("captureEdit.location.placeName")}
          <span className="ml-1.5 text-footnote">{t("import.rows.optional")}</span>
        </label>
        <PlaceNameInput id="bulk-place-name" value={label} onChange={setLabel} regionId={regionId} />
        <p className="mt-1 text-footnote text-muted">{t("gallery.select.setRegionPlaceHint")}</p>
      </div>
    </Modal>
  );
}
