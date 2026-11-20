import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { Spinner } from "../../components/LoadingScreen";
import { MapRow, WithheldPhotosRow } from "./OfflineDataSettings";
import { SettingsGroup } from "./shared";
import DetailedMapsRows from "./DetailedMapsRows";

// Lazy: the region picker's map brings MapLibre, which the other settings groups don't need.
const RegionDownloads = lazy(() => import("../OfflinePacksPage"));

export default function RegionsSettings() {
  const { t } = useTranslation();
  return (
    <>
      <Suspense fallback={<Spinner />}>
        <RegionDownloads />
      </Suspense>
      <SettingsGroup title={t("settings.regions.more")}>
        <MapRow />
        <DetailedMapsRows />
        <WithheldPhotosRow />
      </SettingsGroup>
    </>
  );
}
