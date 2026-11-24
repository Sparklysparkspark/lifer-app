import { useTranslation } from "react-i18next";
import type { FarPhotos } from "../hooks/useSavedSpots";
import { formatNumber } from "../lib/format";
import Button from "./Button";

// Asked inline before filing photos under a place they seem far from: a wrong place is likelier
// than a wrong camera, so their own GPS moves only on "Move these too".
export default function FarPhotosConfirm({
  far,
  busy,
  onFile,
  onCancel,
}: {
  far: FarPhotos;
  busy: boolean;
  /** true moves their points to the place; false keeps them and files the name only. */
  onFile: (moveOwnPoints: boolean) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="space-y-2 rounded-control bg-surface-muted p-3 text-callout">
      <p className="text-ink">
        {t("placePicker.far", { count: far.count, formatted: formatNumber(far.count), km: formatNumber(far.km) })}
      </p>
      {/* Dialog order (ux-rules M11): right-aligned, Cancel first, the primary last. */}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => onFile(true)}>
          {t("placePicker.moveToo")}
        </Button>
        <Button size="sm" loading={busy} onClick={() => onFile(false)}>
          {t("placePicker.fileAnyway")}
        </Button>
      </div>
    </div>
  );
}
