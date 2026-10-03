import { useEffect, useSyncExternalStore } from "react";
import type { LibraryRoot } from "@lifer/shared";
import { getSettingsState, loadSettings, resetSettingsCache, subscribeSettings, type Settings } from "./useSettings";

export type DeploymentMode = "desktop" | "server";

export interface ServerInfo {
  // "desktop" = the API is a local single-user one (SINGLE_USER_MODE), "server" = self-hosted.
  deploymentMode: DeploymentMode;
  // The photo library folder (DATA_DIR) as the API sees it.
  dataDir: string;
  // Admin-declared extra folders (LIFER_LIBRARY_ROOTS); always [] on desktop.
  libraryRoots: LibraryRoot[];
}

// Read from the shared GET /settings cache (useSettings.ts). These fields are fixed for a
// running API, and many components mount this at once.
let derivedFrom: Settings | null = null;
let derived: ServerInfo | null = null;

function toServerInfo(settings: Settings | null): ServerInfo | null {
  if (!settings) return null;
  // Same object back while the source is unchanged, so useSyncExternalStore stays stable.
  if (settings !== derivedFrom) {
    derivedFrom = settings;
    derived = { deploymentMode: settings.deploymentMode, dataDir: settings.dataDir, libraryRoots: settings.libraryRoots ?? [] };
  }
  return derived;
}

export function loadServerInfo(): Promise<ServerInfo> {
  return loadSettings().then((s) => toServerInfo(s)!);
}

// Test-only.
export function resetServerInfoCache(): void {
  resetSettingsCache();
  derivedFrom = null;
  derived = null;
}

/** null until GET /settings has answered once; synchronous on every mount after that. */
export function useServerInfo(): ServerInfo | null {
  const info = useSyncExternalStore(
    subscribeSettings,
    () => toServerInfo(getSettingsState().settings),
    () => toServerInfo(getSettingsState().settings),
  );
  useEffect(() => {
    if (!info) loadServerInfo().catch(() => {});
  }, [info]);
  return info;
}

/** "Is the API a local single-user one?" null while loading. Not the same question as
 * useIsTauri: the desktop shell can be connected to a remote server. */
export function useDeploymentMode(): DeploymentMode | null {
  return useServerInfo()?.deploymentMode ?? null;
}

/** "Am I inside the desktop shell?" (native dialogs, updater, window.liferSetup bridge).
 * window.liferSetup is set synchronously in main.tsx before anything renders. */
export function useIsTauri(): boolean {
  return !!window.liferSetup;
}
