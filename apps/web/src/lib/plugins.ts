// The desktop shell's companion apps: what is installed, and starting one. Never log or store an
// endpoint's pageToken.
import { useEffect, useState, useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";
import type { PluginEndpoint, PluginStatus, PluginSummary } from "@lifer/shared";
import { useDeploymentMode } from "../hooks/useDeploymentMode";
import { ignore } from "./ignore";
import { tauriInvoke } from "./tauri";

export const PLUGIN_STATUS_POLL_MS = 10_000;
const LIST_POLL_MS = 5_000;

// A manifest is untrusted input: these values reach CSS and the DOM only through the checks below.
const COLOR = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([0-9\s.,%/deg]{1,40}\))$/i;
const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9\s.,+-]{1,1024}$/;

export function safeAccent(value: string): string | null {
  return COLOR.test(value.trim()) ? value.trim() : null;
}

/** An SVG path's data, or null for anything else (the caller shows a generic icon). */
export function safeIconPath(value: string): string | null {
  return PATH_DATA.test(value) ? value : null;
}

export function pluginPath(id: string): string {
  return `/apps/${encodeURIComponent(id)}`;
}

/** The app id a /apps/:id path names, or null. */
export function pluginIdFromPath(pathname: string): string | null {
  if (!pathname.startsWith("/apps/")) return null;
  const raw = pathname.slice("/apps/".length);
  // The offer page for an app that isn't installed has no manifest to name.
  if (raw.startsWith("offer/")) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    // A malformed address names no app; the page says so.
    return raw;
  }
}

function invoke<T>(cmd: string, args?: unknown): Promise<T> {
  const call = tauriInvoke();
  return call ? (call(cmd, args) as Promise<T>) : Promise.reject(new Error("Not the desktop app"));
}

// Started apps, in memory only (each holds a page token). The layout keeps one frame mounted per
// entry so a page keeps its state between visits; `generation` changes when the app relaunched.
export type StartedPlugin = { endpoint: PluginEndpoint; generation: number };
let started: ReadonlyMap<string, StartedPlugin> = new Map();
let generations = 0;
const startedListeners = new Set<() => void>();

/** Records a running app's endpoint, or forgets it (null) once the app stopped, which unloads its frame. */
export function setStartedPlugin(id: string, endpoint: PluginEndpoint | null) {
  const was = started.get(id);
  if (endpoint && was && was.endpoint.pageUrl === endpoint.pageUrl && was.endpoint.pageToken === endpoint.pageToken)
    return;
  if (!endpoint && !was) return;
  const next = new Map(started);
  if (endpoint) next.set(id, { endpoint, generation: ++generations });
  else next.delete(id);
  started = next;
  startedListeners.forEach((fn) => fn());
}

export const startedPlugin = (id: string): StartedPlugin | undefined => started.get(id);

export function useStartedPlugins(): ReadonlyMap<string, StartedPlugin> {
  return useSyncExternalStore(
    (fn) => {
      startedListeners.add(fn);
      return () => startedListeners.delete(fn);
    },
    () => started,
  );
}

/** Starts an app, or joins a start already under way. A background start never asks the user and
 *  fails quietly when the app isn't allowed yet. */
export const startPlugin = (id: string, background = false) =>
  invoke<PluginEndpoint>("plugin_start", { id, background });
export const pluginStatus = (id: string) => invoke<PluginStatus>("plugin_status", { id });

// Shared so a second mount (sidebar, then the page) has the list at once, with no flash.
let cached: PluginSummary[] | null = null;
const NONE: PluginSummary[] = [];
const sameList = (a: PluginSummary[] | null, b: PluginSummary[]) =>
  a !== null && JSON.stringify(a) === JSON.stringify(b);

/** True when the app a path names asks for the dark surface (read outside React, for transitions). */
export const isDarkPluginPath = (path: string) =>
  cached?.find((p) => p.id === pluginIdFromPath(path))?.page.surface === "dark";

/** Installed apps; null until the first answer. Always [] outside a local desktop library. */
export function usePlugins(active = true): PluginSummary[] | null {
  const mode = useDeploymentMode(active);
  const enabled = active && mode === "desktop" && tauriInvoke() !== null;
  const [list, setList] = useState<PluginSummary[] | null>(cached);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () =>
      invoke<PluginSummary[]>("plugins_list")
        .then((next) => {
          if (!live) return;
          if (!sameList(cached, next)) cached = next;
          setList((was) => (sameList(was, next) ? was : next));
        })
        .catch(ignore("Couldn't list companion apps"));
    void load();
    // The shell rescans every 5 s, so a new manifest shows up without a restart.
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, LIST_POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [enabled]);
  // null while the deployment mode is unknown, so a page doesn't flash "not installed".
  return mode === null ? null : enabled ? list : NONE;
}

// A companion app that asks for the dark surface darkens the whole window while it is open.
export function useDarkChrome(): boolean {
  const { pathname } = useLocation();
  const appId = pluginIdFromPath(pathname);
  // Only an app path needs the list; elsewhere (login, the signed-out layout) skip GET /settings.
  const plugins = usePlugins(appId !== null);
  return appId !== null && plugins?.find((p) => p.id === appId)?.page.surface === "dark";
}

/** The app ids in a stored list; anything that isn't a list of text is no list. */
export function parseHidden(raw: string | null): ReadonlySet<string> {
  try {
    const list: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

// A set of app ids kept in this browser's storage, shared by every component that reads it.
function storedIds(key: string) {
  const listeners = new Set<() => void>();
  let raw: string | null = null;
  let ids: ReadonlySet<string> = new Set();
  const read = (): ReadonlySet<string> => {
    let next: string | null = null;
    try {
      next = localStorage.getItem(key);
    } catch {
      // Storage blocked: nothing is kept between visits.
    }
    if (next !== raw) {
      raw = next;
      ids = parseHidden(next);
    }
    return ids;
  };
  const write = (next: Set<string>) => {
    raw = JSON.stringify([...next]);
    ids = next;
    try {
      localStorage.setItem(key, raw);
    } catch {
      // Kept in memory for this session.
    }
    listeners.forEach((fn) => fn());
  };
  const subscribe = (fn: () => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  return {
    use: () => useSyncExternalStore(subscribe, read),
    read,
    add: (id: string) => write(new Set(read()).add(id)),
    remove: (id: string) => {
      const next = new Set(read());
      next.delete(id);
      write(next);
    },
  };
}

const hiddenApps = storedIds("lifer:hiddenApps");

/** Apps the user hid from the sidebar. Hiding never uninstalls or revokes anything. */
export function useHiddenPlugins() {
  return { hidden: hiddenApps.use(), hide: hiddenApps.add, show: hiddenApps.remove };
}

// Apps that declare `background` open when Lifer starts unless the user turned that off.
const noBackground = storedIds("lifer:noBackgroundApps");

export const opensInBackground = (p: PluginSummary, off: ReadonlySet<string>) =>
  p.capabilities.includes("background") && !off.has(p.id);

/** The apps the user stopped from opening in the background, and the switch for it. */
export function useBackgroundPlugins() {
  return {
    off: noBackground.use(),
    setBackground: (id: string, on: boolean) => (on ? noBackground.remove(id) : noBackground.add(id)),
  };
}

// "Notices from this app" is on unless the user turned it off.
const noNotices = storedIds("lifer:noNoticeApps");

export const noticesAllowed = (id: string) => !noNotices.read().has(id);

/** The apps whose notices the user turned off, and the switch for it. */
export function useNoticePlugins() {
  return {
    muted: noNotices.use(),
    setNotices: (id: string, on: boolean) => (on ? noNotices.remove(id) : noNotices.add(id)),
  };
}

export interface OfferedImport {
  id: string;
  name: string;
  date: string | null;
  fileCount: number | null;
}

/** Past work an app offers to bring into Lifer. The app has to be open (startPlugin first). */
export const offeredImports = (id: string) => invoke<OfferedImport[]>("plugin_offered_imports", { id });
/** Asks the app to write one piece of work to a folder; resolves to that folder's path. */
export const exportOfferedImport = (id: string, workId: string) =>
  invoke<string>("plugin_export_import", { id, workId });
