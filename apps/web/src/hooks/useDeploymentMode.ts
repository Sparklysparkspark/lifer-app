import { useEffect, useState } from "react";
import type { LibraryRoot } from "@lifer/shared";
import { api } from "../api/client";

export type DeploymentMode = "desktop" | "server";

export interface ServerInfo {
  // "desktop" = the API is a local single-user one (SINGLE_USER_MODE), "server" = self-hosted.
  deploymentMode: DeploymentMode;
  // The photo library folder (DATA_DIR) as the API sees it.
  dataDir: string;
  // Admin-declared extra folders (LIFER_LIBRARY_ROOTS); always [] on desktop.
  libraryRoots: LibraryRoot[];
}

// One GET /settings shared by every caller for the life of the page: these fields are fixed
// for a running API, and many components mount this at once.
let pending: Promise<ServerInfo> | null = null;
let resolved: ServerInfo | null = null;

export function loadServerInfo(): Promise<ServerInfo> {
  if (!pending) {
    pending = api
      .get<ServerInfo>("/settings")
      .then((res) => {
        resolved = { deploymentMode: res.deploymentMode, dataDir: res.dataDir, libraryRoots: res.libraryRoots ?? [] };
        return resolved;
      })
      .catch((err) => {
        // Let a later mount retry (e.g. this ran before sign-in).
        pending = null;
        throw err;
      });
  }
  return pending;
}

// Test-only.
export function resetServerInfoCache(): void {
  pending = null;
  resolved = null;
}

/** null until GET /settings has answered once; synchronous on every mount after that. */
export function useServerInfo(): ServerInfo | null {
  const [info, setInfo] = useState<ServerInfo | null>(resolved);
  useEffect(() => {
    if (info) return;
    let cancelled = false;
    loadServerInfo()
      .then((res) => !cancelled && setInfo(res))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
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
