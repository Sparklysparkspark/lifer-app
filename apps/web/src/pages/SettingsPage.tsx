import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router-dom";
import Button from "../components/Button";
import FormMessage from "../components/FormMessage";
import PageHeader from "../components/PageHeader";
import SettingsSidebar from "../components/SettingsSidebar";
import { useDeploymentMode, useIsTauri } from "../hooks/useDeploymentMode";
import { GROUPS } from "./settings/groups";
import { useSettings } from "../hooks/useSettings";
import { errorMessage } from "../lib/errorMessage";
import { ignore } from "../lib/ignore";
import RegionsSettings from "./settings/RegionsSettings";

/** `subpage`: a page inside a group (Species downloads, inside Species and import), which keeps
 *  that group lit in the sidebar and leads back to it. */
export default function SettingsPage({ subpage }: { subpage?: "downloads" }) {
  const { t } = useTranslation();
  const deploymentMode = useDeploymentMode();
  const isTauri = useIsTauri();
  const params = useParams<{ groupId?: string }>();
  const groupId = subpage ? "species" : params.groupId;
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
      <PageHeader sticky topLevel title={t("settings.title")} />

      {/* The group list is a full-height column beside the app's sidebar, like Mail's or Notes',
          and the panel keeps a reading width beside it, so a wide window leaves its spare room on
          the right instead of floating the whole page in the middle. */}
      <main className="flex flex-col md:min-h-[calc(100vh-var(--mac-title-bar,0px))] md:flex-row">
        <div className="shrink-0 border-line px-page pt-page md:border-r md:px-3 md:pb-page">
          <SettingsSidebar groups={visibleGroups} activeId={active?.id ?? ""} />
        </div>

        <div className="min-w-0 max-w-3xl flex-1 space-y-section p-page">
          {!settings && settingsError != null && (
            <div className="space-y-2">
              <FormMessage error={errorMessage(settingsError, t("settings.loadFailed"))} />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void refresh().catch(ignore("Couldn't reload settings"))}
              >
                {t("settings.retry")}
              </Button>
            </div>
          )}
          {subpage ? (
            <>
              <Link to={`/settings/${groupId}`} className="text-callout text-link hover:underline">
                {t("settings.downloads.back", { group: active?.label ?? "" })}
              </Link>
              <RegionsSettings />
            </>
          ) : (
            active && <active.Component key={active.id} />
          )}
        </div>
      </main>
    </div>
  );
}
