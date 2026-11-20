import type { useVolumeDestination } from "../hooks/useVolumeDestination";
import { useTranslation } from "react-i18next";
import Select from "./Select";

export function VolumeDestinationPicker({
  volumeId,
  setVolumeId,
  connectedVolumes,
  recommendedCount,
  disconnectedRecommendation,
}: ReturnType<typeof useVolumeDestination>) {
  const { t } = useTranslation();
  if (connectedVolumes.length === 0 && !disconnectedRecommendation) return null;

  return (
    <div className="space-y-1 text-left">
      {disconnectedRecommendation && (
        <p className="rounded-control bg-amber-50 px-2 py-1.5 text-footnote text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          {t("volumeDestination.disconnected", {
            count: disconnectedRecommendation.count,
            drive: disconnectedRecommendation.label,
          })}
        </p>
      )}
      {connectedVolumes.length > 0 && (
        <>
          <label className="text-footnote font-medium text-muted">{t("volumeDestination.label")}</label>
          <Select variant="form" value={volumeId} onChange={(e) => setVolumeId(e.target.value)}>
            <option value="">{t("volumeDestination.mainLibrary")}</option>
            {connectedVolumes.map((v) => (
              <option key={v.id} value={v.id}>
                {v.isDefault ? t("volumeDestination.defaultDrive", { drive: v.label }) : v.label}
              </option>
            ))}
          </Select>
          {volumeId && recommendedCount > 0 && (
            <p className="text-footnote text-muted">
              {t("volumeDestination.recommended", { count: recommendedCount })}
            </p>
          )}
        </>
      )}
    </div>
  );
}
