import { useParams } from "react-router-dom";
import Button from "../components/Button";
import FormMessage from "../components/FormMessage";
import PageHeader from "../components/PageHeader";
import SettingsSidebar from "../components/SettingsSidebar";
import { useDeploymentMode, useIsTauri, type DeploymentMode } from "../hooks/useDeploymentMode";
import { useSettings } from "../hooks/useSettings";
import { errorMessage } from "../lib/errorMessage";
import AccountSettings from "./settings/AccountSettings";
import GeneralSettings from "./settings/GeneralSettings";
import IntegrationsSettings from "./settings/IntegrationsSettings";
import LibrarySettings from "./settings/LibrarySettings";
import OfflineDataSettings from "./settings/OfflineDataSettings";
import ServerSettings from "./settings/ServerSettings";
import SpeciesImportSettings from "./settings/SpeciesImportSettings";
import StorageSettings from "./settings/StorageSettings";

// The one list behind both the sidebar and which tab renders. `mode` is the API's deployment mode
// (null while loading). Account is server-only: the desktop user has no password.
interface SettingsGroup {
  id: string;
  label: string;
  visible: (ctx: { mode: DeploymentMode | null; isTauri: boolean }) => boolean;
  Component: () => React.ReactNode;
}

export const GROUPS: SettingsGroup[] = [
  { id: "general", label: "General", visible: () => true, Component: GeneralSettings },
  { id: "account", label: "Account", visible: ({ mode }) => mode === "server", Component: AccountSettings },
  { id: "species", label: "Species and import", visible: () => true, Component: SpeciesImportSettings },
  { id: "library", label: "Library", visible: () => true, Component: LibrarySettings },
  { id: "storage", label: "Storage", visible: () => true, Component: StorageSettings },
  { id: "server", label: "Server", visible: ({ isTauri }) => isTauri, Component: ServerSettings },
  { id: "integrations", label: "Integrations", visible: () => true, Component: IntegrationsSettings },
  { id: "offline-data", label: "Offline data", visible: () => true, Component: OfflineDataSettings },
];

export default function SettingsPage() {
  const deploymentMode = useDeploymentMode();
  const isTauri = useIsTauri();
  const { groupId } = useParams<{ groupId?: string }>();
  const { settings, error: settingsError, refresh } = useSettings();

  const visibleGroups = GROUPS.filter((g) => g.visible({ mode: deploymentMode, isTauri }));
  // A deep link to a mode-dependent group waits for the mode instead of bouncing to General.
  const awaitingMode =
    deploymentMode === null && !!groupId && GROUPS.some((g) => g.id === groupId) && !visibleGroups.some((g) => g.id === groupId);
  const active = awaitingMode ? null : (visibleGroups.find((g) => g.id === groupId) ?? visibleGroups[0] ?? GROUPS[0]);

  return (
    <div className="flex-1 bg-canvas">
      <PageHeader sticky title="Settings" />

      <main className="mx-auto flex max-w-6xl flex-col gap-8 p-6 md:flex-row">
        <SettingsSidebar groups={visibleGroups} activeId={active?.id ?? ""} />

        <div className="min-w-0 flex-1 space-y-8">
          {!settings && settingsError != null && (
            <div className="space-y-2">
              <FormMessage error={errorMessage(settingsError, "Couldn't load your settings. Some options are hidden until they load.")} />
              <Button variant="secondary" size="sm" onClick={() => void refresh().catch(() => {})}>
                Retry
              </Button>
            </div>
          )}
          {active && <active.Component key={active.id} />}
        </div>
      </main>
    </div>
  );
}
