// Lifer's side of the host protocol (packages/shared/src/pluginProtocol.ts): checks every message's
// origin and source window, validates it, runs what the manifest's capabilities allow, and replies.
import { useEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  chordMatches,
  parsePluginMessage,
  PLUGIN_INTERACTIVE_TYPES,
  PLUGIN_PROTOCOL_VERSION,
  PLUGIN_REPLY_TIMEOUT_MS,
  type HostPreference,
  type HostPreferenceDecision,
  type HostToPluginMessage,
  type NavigateTarget,
  type PluginCapability,
  type PluginErrorCode,
  type PluginHostPlatform,
  type PluginInit,
  type PluginNotice,
  type PluginReply,
  type PluginReplyResult,
  type PluginTheme,
  type PluginToHostMessage,
  type ShortcutChord,
} from "@lifer/shared";
import { api, ApiError, apiPath } from "../api/client";
import { useCommandPalette } from "../hooks/useCommandPalette";
import { useLatest } from "../hooks/useLatest";
import { useTheme } from "../hooks/useTheme";
import { useToast } from "../hooks/useToast";
import i18n from "../i18n";
import { askHostPreference, getHostPreference, onHostPreference } from "./hostPreference";
import { ignore } from "./ignore";
import { MAIN_PAGE_ROUTES } from "./mainPages";
import { openExternal } from "./openExternal";
import { noticesAllowed, pluginPath } from "./plugins";
import { registerThemeSync, waitApplied } from "./themeFade";

type HostAction = { go: string } | "palette" | "sidebar" | null;

/** The chords Lifer keeps while a plugin page has focus, with what each does. */
export function hostShortcuts(mac: boolean): Array<{ chord: ShortcutChord; action: HostAction }> {
  const mod = (key: string, extra: Partial<ShortcutChord> = {}): ShortcutChord => ({
    key,
    meta: mac,
    ctrl: !mac,
    alt: false,
    shift: false,
    ...extra,
  });
  const pages = [1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((n) => {
    const action: HostAction = MAIN_PAGE_ROUTES[n - 1] ? { go: MAIN_PAGE_ROUTES[n - 1] } : null;
    // By position, so they work on every layout; the numpad counts too.
    return [
      { chord: mod(String(n), { code: `Digit${n}` }), action },
      { chord: mod(String(n), { code: `Numpad${n}` }), action },
    ];
  });
  return [
    ...pages,
    { chord: mod("k"), action: "palette" },
    { chord: mod("f"), action: "palette" },
    { chord: mod(","), action: { go: "/settings" } },
    { chord: mod("i"), action: { go: "/import" } },
    { chord: mod("i", { shift: true }), action: { go: "/import" } },
    { chord: mac ? mod("s", { ctrl: true }) : mod("s", { alt: true }), action: "sidebar" },
  ];
}

const THEME_TOKENS = [
  "--color-canvas",
  "--color-surface",
  "--color-surface-muted",
  "--color-line",
  "--color-ink",
  "--color-muted",
  "--color-accent",
  "--color-accent-fg",
  "--color-control",
  "--color-control-line",
  "--color-link",
];

/** The tokens in effect where the frame sits, so a dark plugin surface reads as dark. */
export function frameTheme(frame: HTMLElement): PluginTheme {
  const style = getComputedStyle(frame);
  const tokens: Record<string, string> = {};
  for (const name of THEME_TOKENS) {
    const value = style.getPropertyValue(name).trim();
    if (value) tokens[name] = value;
  }
  return { mode: frame.closest(".dark") ? "dark" : "light", tokens };
}

/** Lifer's own theme, whatever surface a plugin page asks for. */
const liferTheme = () => frameTheme(document.documentElement);

function hostPlatform(): PluginHostPlatform {
  const p = window.liferSetup?.platform;
  return p === "darwin" ? "macos" : p === "win32" ? "windows" : "linux";
}

// Local absolute paths only. No UNC or "//" paths: revealing one makes Windows contact that host
// and send the user's credentials. No ".." segments, so a path means what it says.
const isLocalPath = (p: string) =>
  (/^\/(?!\/)/.test(p) || /^[A-Za-z]:[\\/]/.test(p)) && !p.split(/[\\/]/).includes("..");

export interface PluginHostActions {
  go(path: string): void;
  palette(): void;
  sidebar(): void;
  /** Resolves to an error code, or null once the page is open. */
  navigate(target: NavigateTarget): Promise<PluginErrorCode | null>;
  title(text: string): void;
  pickFolder(title?: string): Promise<string | null>;
  pickFiles(title?: string): Promise<string[] | null>;
  reveal(path: string): Promise<void>;
  openUrl(url: string): void;
  notify(notice: PluginNotice): void;
  /** Rejects with not-allowed when the app's key lacks the host.preference scope. */
  hostPreference(): Promise<HostPreference>;
  requestHostPreference(openInHost: boolean): Promise<HostPreferenceDecision>;
}

export interface PluginHostOptions {
  /** The origin the shell reported for this plugin; nothing else is trusted. */
  origin: string;
  /** The page token, sent as `credential` after each valid `ready`. */
  token: string;
  capabilities: readonly PluginCapability[];
  frame: () => HTMLIFrameElement | null;
  init: () => Promise<PluginInit>;
  shortcuts: Array<{ chord: ShortcutChord; action: HostAction }>;
  actions: PluginHostActions;
  /** Per-plugin "Notices from this app" setting. */
  noticesAllowed?: () => boolean;
}

class Refused extends Error {
  constructor(readonly code: PluginErrorCode) {
    super(code);
  }
}

/** Listens for one plugin frame's messages. `post` sends only after the page said `ready`. */
export function attachPluginHost(opts: PluginHostOptions): {
  post: (msg: HostToPluginMessage) => void;
  /** Sends the theme, resolving when the page confirms it applied it (or after a short wait). */
  applyTheme: (theme: PluginTheme) => Promise<void>;
  /** host.preference.changed, only to a page that was allowed to read the preference. */
  pushHostPreference: (pref: HostPreference) => void;
  dispose: () => void;
} {
  let applied: (() => void) | undefined;
  let ready = false;
  let disposed = false;
  // One native picker at a time, so a page can't stack dialogs.
  let picking = false;
  let prefAllowed = false;
  const send = (msg: HostToPluginMessage) => {
    // An explicit targetOrigin: if the frame navigated elsewhere, the message is dropped.
    if (!disposed) opts.frame()?.contentWindow?.postMessage(msg, opts.origin);
  };
  const reply = (id: string | undefined, payload: PluginReply) => {
    if (id !== undefined) send({ lifer: PLUGIN_PROTOCOL_VERSION, type: "reply", id, payload });
  };
  const need = (cap: PluginCapability) => {
    if (!opts.capabilities.includes(cap)) throw new Refused("not-allowed");
  };

  async function run(msg: PluginToHostMessage): Promise<PluginReplyResult> {
    const a = opts.actions;
    switch (msg.type) {
      case "ready":
        ready = true;
        // Only here: the origin and source checks in onMessage have passed.
        send({ lifer: PLUGIN_PROTOCOL_VERSION, type: "credential", payload: { token: opts.token } });
        send({ lifer: PLUGIN_PROTOCOL_VERSION, type: "init", payload: await opts.init() });
        return null;
      case "themeApplied":
        applied?.();
        return null;
      case "shortcut": {
        const action = opts.shortcuts.find((s) => chordMatches(s.chord, msg.payload))?.action;
        if (action === "palette") a.palette();
        else if (action === "sidebar") a.sidebar();
        else if (action) a.go(action.go);
        return null;
      }
      case "navigate": {
        const error = await a.navigate(msg.payload);
        if (error) throw new Refused(error);
        return null;
      }
      case "title":
        a.title(msg.payload.text.trim());
        return null;
      case "pickFolder":
      case "pickFiles": {
        need("pickers");
        if (picking) throw new Refused("failed");
        picking = true;
        try {
          return await (msg.type === "pickFolder" ? a.pickFolder(msg.payload.title) : a.pickFiles(msg.payload.title));
        } finally {
          picking = false;
        }
      }
      case "reveal":
        if (!isLocalPath(msg.payload.path)) throw new Refused("invalid");
        await a.reveal(msg.payload.path);
        return null;
      case "openUrl": {
        let https = false;
        try {
          https = new URL(msg.payload.url).protocol === "https:";
        } catch {
          // Not a URL at all.
        }
        if (!https) throw new Refused("invalid");
        a.openUrl(msg.payload.url);
        return null;
      }
      case "notify":
        need("notifications");
        if (opts.noticesAllowed && !opts.noticesAllowed()) throw new Refused("not-allowed");
        a.notify(msg.payload);
        return null;
      case "host.preference.get":
      case "host.preference.request": {
        need("host.preference");
        const result = await (msg.type === "host.preference.get"
          ? a.hostPreference()
          : a.requestHostPreference(msg.payload.openInHost));
        prefAllowed = true;
        return result;
      }
    }
  }

  function onMessage(event: MessageEvent) {
    const frame = opts.frame();
    // Both checks: another frame could share the origin, and another origin could hold our frame.
    if (event.origin !== opts.origin || !frame || event.source !== frame.contentWindow) return;
    const parsed = parsePluginMessage(event.data);
    if (!parsed) return;
    if (!parsed.ok) return reply(parsed.id, { ok: false, error: "invalid" });
    const { message } = parsed;
    let work = run(message);
    if (!PLUGIN_INTERACTIVE_TYPES.includes(message.type)) {
      work = Promise.race([
        work,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Refused("timeout")), PLUGIN_REPLY_TIMEOUT_MS)),
      ]);
    }
    work.then(
      (result) => reply(message.id, { ok: true, result }),
      (err: unknown) => reply(message.id, { ok: false, error: err instanceof Refused ? err.code : "failed" }),
    );
  }

  window.addEventListener("message", onMessage);
  return {
    post: (msg) => ready && send(msg),
    pushHostPreference: (payload) =>
      ready && prefAllowed && send({ lifer: PLUGIN_PROTOCOL_VERSION, type: "host.preference.changed", payload }),
    applyTheme: (theme) => {
      if (!ready || disposed) return Promise.resolve();
      return waitApplied((done) => {
        applied = done;
        send({ lifer: PLUGIN_PROTOCOL_VERSION, type: "theme", payload: theme });
      });
    },
    dispose: () => {
      disposed = true;
      window.removeEventListener("message", onMessage);
    },
  };
}

// Titles a page set, read by the toolbar. In memory only, cleared when its frame goes away.
let titles = new Map<string, string>();
const titleListeners = new Set<() => void>();
function setPluginTitle(id: string, text: string | null) {
  const next = new Map(titles);
  if (text) next.set(id, text);
  else next.delete(id);
  titles = next;
  titleListeners.forEach((fn) => fn());
}
/** The title a plugin's page asked for, or null. */
export function usePluginTitle(id: string | null): string | null {
  const map = useSyncExternalStore(
    (fn) => {
      titleListeners.add(fn);
      return () => titleListeners.delete(fn);
    },
    () => titles,
  );
  return id ? (map.get(id) ?? null) : null;
}

// A burst of notices from one app collapses into one notice that counts them.
const NOTICE_WINDOW_MS = 8000;
const notices = new Map<string, { toastId: number; count: number; at: number }>();

async function speciesByName(scientificName: string): Promise<string | null> {
  const res = await api.get(apiPath("/species", {}, new URLSearchParams({ q: scientificName })));
  const wanted = scientificName.trim().toLowerCase();
  return res.results.find((s) => s.scientific_name.toLowerCase() === wanted)?.id ?? null;
}

// Lifer answers 404 for an app that isn't paired with the host.preference scope.
const hostRefusal = (err: unknown): never => {
  throw new Refused(err instanceof ApiError && err.status === 404 ? "not-allowed" : "failed");
};

async function dialog() {
  return (await import("@tauri-apps/plugin-dialog")).open;
}

/**
 * Wires one plugin frame to Lifer: theme, language and visibility changes, and the page's requests.
 * `visible` is whether its page is the one on screen.
 */
export function usePluginHost({
  pluginId,
  name,
  origin,
  token,
  capabilities,
  frameRef,
  visible,
}: {
  pluginId: string;
  name: string;
  origin: string;
  token: string;
  capabilities: readonly PluginCapability[];
  frameRef: RefObject<HTMLIFrameElement | null>;
  visible: boolean;
}): void {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const { open: openPalette } = useCommandPalette();
  const { theme } = useTheme();
  const host = useRef<ReturnType<typeof attachPluginHost> | null>(null);
  // Read by the long-lived listener, so a re-render never re-attaches it.
  const live = useLatest({ navigate, toast, openPalette, t, name, visible });

  useEffect(() => {
    const shown = () => live.current.visible && document.visibilityState === "visible";
    const mac = hostPlatform() === "macos";
    host.current = attachPluginHost({
      origin,
      token,
      capabilities,
      frame: () => frameRef.current,
      shortcuts: hostShortcuts(mac),
      noticesAllowed: () => noticesAllowed(pluginId),
      init: async () => {
        const hostVersion = await import("@tauri-apps/api/app").then((m) => m.getVersion()).catch(() => "");
        const frame = frameRef.current;
        return {
          protocol: PLUGIN_PROTOCOL_VERSION,
          theme: frame && live.current.visible ? frameTheme(frame) : liferTheme(),
          locale: i18n.resolvedLanguage ?? i18n.language,
          platform: hostPlatform(),
          reservedShortcuts: hostShortcuts(mac).map((s) => s.chord),
          hostVersion,
          visible: shown(),
        };
      },
      actions: {
        go: (path) => live.current.navigate(path),
        palette: () => live.current.openPalette(),
        // The same event the View menu sends, so App's handler toggles it.
        sidebar: () =>
          void import("@tauri-apps/api/event")
            .then(({ emit }) => emit("menu:toggle-sidebar"))
            .catch(ignore("Couldn't toggle the sidebar")),
        navigate: async (target) => {
          if (target.to === "gallery") {
            live.current.navigate(target.query ? `/gallery?q=${encodeURIComponent(target.query)}` : "/gallery");
            return null;
          }
          // shortcut: Lifer has no page for one photo yet; add it when the gallery can deep link.
          if (target.to === "photo") return "unsupported";
          const id = await speciesByName(target.scientificName);
          if (!id) return "not-found";
          live.current.navigate(`/species/${id}`);
          return null;
        },
        title: (text) => setPluginTitle(pluginId, text || null),
        pickFolder: async (title) => {
          const path = await (await dialog())({ directory: true, title });
          return typeof path === "string" ? path : null;
        },
        pickFiles: async (title) => {
          const paths = await (await dialog())({ multiple: true, title });
          return Array.isArray(paths) && paths.length ? paths : null;
        },
        reveal: async (path) => (await import("@tauri-apps/plugin-opener")).revealItemInDir(path),
        openUrl: (url) => openExternal(url),
        notify: (notice) => {
          const { toast, t, name, navigate } = live.current;
          const now = Date.now();
          const prev = notices.get(pluginId);
          const count = prev && now - prev.at < NOTICE_WINDOW_MS ? prev.count + 1 : 1;
          if (prev) toast.dismiss(prev.toastId);
          const message =
            count > 1
              ? t("plugins.noticeMany", { name, count, title: notice.title })
              : notice.body
                ? t("plugins.noticeBody", { name, title: notice.title, body: notice.body })
                : t("plugins.notice", { name, title: notice.title });
          const toastId = toast.show(message, {
            tone: "info",
            // Its button opens the app's page, so there's none while that page is on screen.
            actions: shown()
              ? undefined
              : [{ label: notice.action || t("plugins.noticeOpen"), onClick: () => navigate(pluginPath(pluginId)) }],
          });
          notices.set(pluginId, { toastId, count, at: now });
        },
        hostPreference: () => getHostPreference(pluginId).catch(hostRefusal),
        requestHostPreference: (openInHost) => askHostPreference(pluginId, openInHost).catch(hostRefusal),
      },
    });
    const offPreference = onHostPreference(pluginId, (pref) => host.current?.pushHostPreference(pref));
    const onVisibility = () => host.current?.post({ lifer: 1, type: "visibility", payload: { visible: shown() } });
    const onLanguage = (locale: string) => host.current?.post({ lifer: 1, type: "locale", payload: { locale } });
    document.addEventListener("visibilitychange", onVisibility);
    i18n.on("languageChanged", onLanguage);
    // Inside a view transition: the theme this frame will show, so its new snapshot is already right.
    const unregister = registerThemeSync(async () => {
      const frame = frameRef.current;
      if (frame) await host.current?.applyTheme(live.current.visible ? frameTheme(frame) : liferTheme());
    });
    return () => {
      offPreference();
      unregister();
      document.removeEventListener("visibilitychange", onVisibility);
      i18n.off("languageChanged", onLanguage);
      host.current?.dispose();
      host.current = null;
      setPluginTitle(pluginId, null);
    };
    // capabilities is compared by content: a fresh array from the same list must not re-attach.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginId, origin, token, capabilities.join(","), frameRef]);

  useEffect(() => {
    host.current?.post({
      lifer: 1,
      type: "visibility",
      payload: { visible: visible && document.visibilityState === "visible" },
    });
  }, [visible]);

  // Shown: its own surface's theme. Hidden: Lifer's theme, so the next visit starts in step.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    host.current?.post({
      lifer: 1,
      type: "theme",
      payload: visible ? frameTheme(frame) : liferTheme(),
    });
  }, [theme, visible, frameRef]);
}
