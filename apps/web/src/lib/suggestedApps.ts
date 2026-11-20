// Apps Lifer can suggest installing (data/suggestedApps.json, empty until the maintainer adds
// one). Offers exist only in the desktop app, only while "Show suggested apps" is on, and only
// for apps that aren't installed. Nothing is requested until the user presses Install.
import { useSyncExternalStore } from "react";
import { api, type ApiBody } from "../api/client";
import { useDeploymentMode } from "../hooks/useDeploymentMode";
import suggested from "../data/suggestedApps.json";
import { platform } from "./platform";
import { usePlugins } from "./plugins";
import { tauriInvoke } from "./tauri";

export interface SuggestedInstaller {
  url: string;
  /** macOS team id, Windows "subject\nissued by issuer", or the Linux minisign public key. */
  signer: string;
  /** Linux only: where the detached minisign signature is. */
  signatureUrl?: string;
  /** True while url and signer are placeholders: the offer shows "Available soon" and installs nothing. */
  pending?: boolean;
}

export interface SuggestedApp {
  /** The id its manifest will use once installed. */
  id: string;
  name: string;
  description: string;
  publisher: string;
  homepage: string;
  label: string;
  /** Shows the longer offer copy (suggestedApps.<offer>.*) on the offer page. */
  offer?: "cull";
  /** The API scopes it will ask for, shown on the offer page; pressing its button allows exactly these. */
  scopes?: string[];
  /** Monochrome SVG path data, like a manifest's page icon. */
  icon: string;
  downloads: Partial<Record<"darwin" | "win32" | "linux", SuggestedInstaller>>;
}

export const SUGGESTED_APPS: readonly SuggestedApp[] = suggested as SuggestedApp[];

const OS_KEY = { mac: "darwin", windows: "win32", other: "linux" } as const;
/** The installer for this computer's system, if the app has one. */
export const installerFor = (app: SuggestedApp): SuggestedInstaller | undefined => app.downloads[OS_KEY[platform]];

const KEY = "lifer:showSuggestedApps";
const listeners = new Set<() => void>();

function readShow(): boolean {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

export function setShowSuggestedApps(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    // Kept for this session only if storage is blocked.
  }
  listeners.forEach((fn) => fn());
}

export function useShowSuggestedApps(): boolean {
  return useSyncExternalStore((fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, readShow);
}

/** What to offer: nothing outside the desktop app, with the setting off, or for an app already installed. */
export function useSuggestedApps(): SuggestedApp[] {
  const mode = useDeploymentMode();
  const show = useShowSuggestedApps();
  const installed = usePlugins();
  if (SUGGESTED_APPS.length === 0 || mode !== "desktop" || tauriInvoke() === null || !show || installed === null)
    return [];
  return SUGGESTED_APPS.filter((a) => !installed.some((p) => p.id === a.id));
}

export const offerPath = (id: string) => `/apps/offer/${encodeURIComponent(id)}`;

export interface InstallProgress {
  downloaded: number;
  total: number;
  running: boolean;
}

const invoke = <T>(cmd: string, args: unknown) => {
  const call = tauriInvoke();
  return call ? (call(cmd, args) as Promise<T>) : Promise.reject(new Error("Not the desktop app"));
};

export const installSuggestedApp = (app: SuggestedApp, installer: SuggestedInstaller) =>
  invoke<void>("plugin_install", {
    appId: app.id,
    url: installer.url,
    signer: installer.signer,
    signatureUrl: installer.signatureUrl ?? null,
  });
/** The user's click on the offer page is their consent: the app's next launch from Lifer pairs
 *  with these scopes without asking again (api plugins/routes.ts, grants). */
export const grantSuggestedApp = (app: SuggestedApp) =>
  api.post("/plugins/v1/grants", {
    pluginId: app.id,
    name: app.name,
    scopes: (app.scopes ?? []) as ApiBody<"/plugins/v1/grants", "post">["scopes"],
  });
export const installProgress = (id: string) => invoke<InstallProgress>("plugin_install_progress", { appId: id });
export const cancelInstall = (id: string) => invoke<void>("plugin_install_cancel", { appId: id });
