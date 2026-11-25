import { useTranslation } from "react-i18next";
import Button from "../../components/Button";
import { docsUrl } from "../../lib/docs";
import { openExternal } from "../../lib/openExternal";
import { platform } from "../../lib/platform";
import { useShowSuggestedApps } from "../../lib/suggestedApps";
import { SettingRow, SettingsGroup } from "./shared";

const GUIDE = "/guides/other-apps-and-keywords";

/** Settings > Connected apps: the apps that read the keywords Lifer writes, each with a one-line
 *  how-to and its section of the guide. Hidden with "Show suggested apps"; Apple Photos is Mac only. */
export default function WorksWithApps() {
  const { t } = useTranslation();
  const show = useShowSuggestedApps();
  if (!show) return null;
  const apps = [
    { id: "lightroom-classic", name: t("worksWith.lightroom.name"), how: t("worksWith.lightroom.how") },
    ...(platform === "mac"
      ? [{ id: "apple-photos", name: t("worksWith.photos.name"), how: t("worksWith.photos.how") }]
      : []),
    { id: "folders", name: t("worksWith.folders.name"), how: t("worksWith.folders.how") },
    { id: "adobe-bridge", name: t("worksWith.bridge.name"), how: t("worksWith.bridge.how") },
    { id: "adobe-photoshop", name: t("worksWith.photoshop.name"), how: t("worksWith.photoshop.how") },
    { id: "dxo-photolab", name: t("worksWith.dxo.name"), how: t("worksWith.dxo.how") },
    { id: "peakto", name: t("worksWith.peakto.name"), how: t("worksWith.peakto.how") },
  ];
  return (
    <SettingsGroup title={t("worksWith.title")}>
      {apps.map((a) => (
        <SettingRow
          key={a.id}
          label={a.name}
          description={a.how}
          control={
            <Button
              variant="link"
              size="sm"
              aria-label={t("worksWith.guideLabel", { name: a.name })}
              onClick={() => openExternal(docsUrl(`${GUIDE}#${a.id}`))}
            >
              {t("worksWith.guide")}
            </Button>
          }
        />
      ))}
    </SettingsGroup>
  );
}
