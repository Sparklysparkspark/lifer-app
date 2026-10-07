import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import Button from "../components/Button";
import FormMessage from "../components/FormMessage";
import PageHeader from "../components/PageHeader";
import SettingsSidebar from "../components/SettingsSidebar";
import { useDeploymentMode, useIsTauri } from "../hooks/useDeploymentMode";
import { GROUPS } from "./settings/groups";
import { useSettings } from "../hooks/useSettings";
import { errorMessage } from "../lib/errorMessage";

export default function SettingsPage() {
  const { t } = useTranslation();
  const deploymentMode = useDeploymentMode();
  const isTauri = useIsTauri();
  const { groupId } = useParams<{ groupId?: string }>();
  const { settings, error: settingsError, refresh } = useSettings();

  const visibleGroups = GROUPS.filter((g) => g.visible({ mode: deploymentMode, isTauri }));
  // A deep link to a mode-dependent group waits for the mode instead of bouncing to General.
  const awaitingMode =
    deploymentMode === null &&
    !!groupId &&
    GROUPS.some((g) => g.id === groupId) &&
    !visibleGroups.some((g) => g.id === groupId);
  const active = awaitingMode ? null : (visibleGroups.find((g) => g.id === groupId) ?? visibleGroups[0] ?? GROUPS[0]);

  return (
    <div className="flex-1 bg-canvas">
      <PageHeader sticky title={t("settings.title")} />

      <main className="mx-auto flex max-w-6xl flex-col gap-8 p-6 md:flex-row">
        <SettingsSidebar groups={visibleGroups} activeId={active?.id ?? ""} />

        <div className="min-w-0 flex-1 space-y-8">
          {!settings && settingsError != null && (
            <div className="space-y-2">
              <FormMessage error={errorMessage(settingsError, t("settings.loadFailed"))} />
              <Button variant="secondary" size="sm" onClick={() => void refresh().catch(() => {})}>
                {t("settings.retry")}
              </Button>
            </div>
          )}
          {active && <active.Component key={active.id} />}
        </div>
      </main>
    </div>
  );
}
