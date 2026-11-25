// Apps Lifer can suggest installing (data/suggestedApps.json, empty until the maintainer adds
// one). Offers exist only in the desktop app, only while "Show suggested apps" is on, and only
// for apps that aren't installed. Nothing is requested until the user presses Install.
import { useEffect, useState, useSyncExternalStore } from "react";
import { api, type ApiBody } from "../api/client";
import { useDeploymentMode } from "../hooks/useDeploymentMode";
import suggested from "../data/suggestedApps.json";
import { usePlugins } from "./plugins";
import { tauriInvoke } from "./tauri";

/** One target's trust anchor. The desktop shell reads these compiled in; the page only shows them. */
export interface SuggestedTarget {
  /** dmg (macOS), nsis or msi (Windows), deb or rpm (Linux). An appimage never installs from Lifer. */
  format: string;
  /** macOS Team ID, or the Windows certificate subject. */
  signer?: string;
  /** This target's own minisign keys; the install block's apply when empty. */
  minisignKeys?: string[];
  /** Windows only: allowed issuers; empty allows any issuer Windows trusts. */
  issuers?: string[];
}

/** How Lifer gets the publisher's own installer (plugin_install.rs). */
export interface SuggestedInstall {
  /** The publisher's feed; {channel} is replaced by channel. */
  feed: string;
  channel?: string;
  /** Exact hosts the feed and installer may come from, also after redirects. */
  hosts: string[];
  minisignKeys: string[];
  /** True while anchors are placeholders: the offer shows "Available soon" and installs nothing. */
  pending?: boolean;
  /** Keyed by target: darwin-aarch64, darwin-x86_64, windows-x86_64, linux-x86_64. */
  platforms: Record<string, SuggestedTarget>;
  /** Keyed by darwin, win32 or linux: where a copy installed on its own keeps its program. */
  locations?: Record<string, string[]>;
}

/** What the offer page needs to know about installing on this computer. */
export interface SuggestedInstaller {
  /** The host the download starts from, named in the disclosure. */
  host: string;
  pending: boolean;
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
  /** A picture for the sidebar instead (the app's own logo, in its own colours), and its dark-theme variant. */
  iconSrc?: string;
  iconSrcDark?: string;
  /** Price, trial or licence words in the publisher's own terms, shown on the offer page. */
  pricingText?: string;
  licenseUrl?: string;
  /** The publisher's own uninstall instructions; Lifer never removes an app itself. */
  uninstallHelp?: string;
  install?: SuggestedInstall;
}

export const SUGGESTED_APPS: readonly SuggestedApp[] = suggested as SuggestedApp[];

let targetPromise: Promise<string | null> | undefined;
/** This computer's target key (darwin-aarch64, darwin-x86_64, ...), asked of the desktop shell
 *  that knows its own chip; null outside it or if it can't say. */
export function loadTargetKey(): Promise<string | null> {
  targetPromise ??= invoke<string>("plugin_target", {}).catch(() => null);
  return targetPromise;
}

/** null until the shell has answered. */
export function useTargetKey(): string | null {
  const [key, setKey] = useState<string | null>(null);
  useEffect(() => {
    void loadTargetKey().then(setKey);
  }, []);
  return key;
}

/** An Intel Mac runs the app on the CPU only, which is slower; the offer page says so. */
export const isIntelMac = (target: string | null) => target === "darwin-x86_64";

/** Installing on this computer, if the app has an installer Lifer can open here. */
export function installerFor(app: SuggestedApp, target: string | null): SuggestedInstaller | undefined {
  const install = app.install;
  const anchor = target ? install?.platforms[target] : undefined;
  if (!install || !anchor || anchor.format === "appimage") return undefined;
  const pending = install.pending === true || JSON.stringify(install).includes("PLACEHOLDER");
  let host = "";
  try {
    host = new URL(install.feed).hostname;
  } catch {
    // A malformed feed can't install; the shell refuses it too.
  }
  return { host, pending: pending || !host };
}

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
  stage: "downloading" | "verifying" | "opening";
}

const invoke = <T>(cmd: string, args: unknown) => {
  const call = tauriInvoke();
  return call ? (call(cmd, args) as Promise<T>) : Promise.reject(new Error("Not the desktop app"));
};

/** The shell looks up every address, key and signer itself; the page only names the app. */
export const installSuggestedApp = (app: SuggestedApp) => invoke<void>("plugin_install", { appId: app.id });

/** Where a copy installed outside Lifer is, once its signer checks out; null when there is none. */
export const detectInstalled = (id: string) => invoke<string | null>("plugin_detect", { appId: id });
/** Opens that copy the way the system would; it then connects to Lifer on its own. */
export const openInstalled = (id: string) => invoke<void>("plugin_open_installed", { appId: id });

// The shell's error codes (plugin_install.rs) and their words.
const INSTALL_ERRORS: Record<string, string> = {
  "not-set-up": "suggestedApps.error.notSetUp",
  "no-installer": "suggestedApps.error.noInstaller",
  busy: "suggestedApps.error.busy",
  offline: "suggestedApps.error.offline",
  unavailable: "suggestedApps.error.unavailable",
  verification: "suggestedApps.error.verification",
  "too-large": "suggestedApps.error.tooLarge",
  space: "suggestedApps.error.space",
  blocked: "suggestedApps.error.blocked",
};
/** The i18n key for an install failure; null for a cancel, which needs no message. */
export function installErrorKey(err: unknown): string | null {
  if (err === "cancelled") return null;
  return (typeof err === "string" && INSTALL_ERRORS[err]) || "suggestedApps.failed";
}
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
