import type { ReactNode } from "react";
import i18n from "../../i18n";
import type { DeploymentMode } from "../../hooks/useDeploymentMode";
import AccountSettings from "./AccountSettings";
import GeneralSettings from "./GeneralSettings";
import IntegrationsSettings from "./IntegrationsSettings";
import LibrarySettings from "./LibrarySettings";
import OfflineDataSettings from "./OfflineDataSettings";
import ServerSettings from "./ServerSettings";
import SpeciesImportSettings from "./SpeciesImportSettings";
import StorageSettings from "./StorageSettings";

// The one list behind both the sidebar and which tab renders. `mode` is the API's deployment mode
// (null while loading). Account is server-only: the desktop user has no password. `id` is the
// URL segment and never translated; `label` translates each time it's read, in the active language.
interface SettingsGroup {
  id: string;
  readonly label: string;
  visible: (ctx: { mode: DeploymentMode | null; isTauri: boolean }) => boolean;
  Component: () => ReactNode;
}

export const GROUPS: SettingsGroup[] = [
  {
    id: "general",
    get label() {
      return i18n.t("settings.groups.general");
    },
    visible: () => true,
    Component: GeneralSettings,
  },
  {
    id: "account",
    get label() {
      return i18n.t("settings.groups.account");
    },
    visible: ({ mode }) => mode === "server",
    Component: AccountSettings,
  },
  {
    id: "species",
    get label() {
      return i18n.t("settings.groups.species");
    },
    visible: () => true,
    Component: SpeciesImportSettings,
  },
  {
    id: "library",
    get label() {
      return i18n.t("settings.groups.library");
    },
    visible: () => true,
    Component: LibrarySettings,
  },
  {
    id: "storage",
    get label() {
      return i18n.t("settings.groups.storage");
    },
    visible: () => true,
    Component: StorageSettings,
  },
  {
    id: "server",
    get label() {
      return i18n.t("settings.groups.server");
    },
    visible: ({ isTauri }) => isTauri,
    Component: ServerSettings,
  },
  {
    id: "integrations",
    get label() {
      return i18n.t("settings.groups.integrations");
    },
    visible: () => true,
    Component: IntegrationsSettings,
  },
  {
    id: "offline-data",
    get label() {
      return i18n.t("settings.groups.offlineData");
    },
    visible: () => true,
    Component: OfflineDataSettings,
  },
];
