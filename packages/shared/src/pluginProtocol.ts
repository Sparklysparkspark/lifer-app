// Host protocol, version 1: the postMessage contract between a companion app's page (in Lifer's
// plugin iframe) and Lifer, plus the process contract the launched executable must keep. Public:
// any plugin author can copy this file. docs/plans/plugin-host-and-integration-api.md section 4.

export const PLUGIN_PROTOCOL_VERSION = 1;

/*
 * Process contract (enforced by apps/desktop/src-tauri/src/plugins.rs; change only together):
 * - Launch: `<executable> --lifer-host --protocol=1` with LIFER_HOST_TICKET (64 lowercase hex,
 *   secret, new per launch) and LIFER_WATCH_PARENT_PID in the environment.
 * - Once the health route answers, print one stdout line:
 *   `LIFER_PLUGIN_READY port=<port> page=<path> pageToken=<token>`.
 * - Health: GET http://127.0.0.1:<port>/lifer-host/health?nonce=<64 hex> must answer 200 JSON
 *   `{ "proof": hex(HMAC-SHA256(key = ticket string bytes, message = nonce string bytes)) }`
 *   within 3 s. It needs no pageToken.
 * - The page URL carries no pageToken. Serve the page without it, then wait for the `credential`
 *   message (below) and send the token with the page's own requests to your server.
 * - Exit when stdin closes or LIFER_WATCH_PARENT_PID is gone. Exit 0 only when the user closed it.
 */
export const PLUGIN_HEALTH_PATH = "/lifer-host/health";
export interface PluginHealthResponse {
  proof: string;
}

/**
 * A key chord. `code` (e.g. "Digit1") is set for keys matched by position, so they work on any
 * keyboard layout; otherwise `key` is compared lowercased. Modifiers must match exactly.
 */
export interface ShortcutChord {
  key: string;
  code?: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export type PluginThemeMode = "light" | "dark";
/** `tokens` maps CSS custom property names (e.g. "--color-canvas") to values, ready for setProperty. */
export interface PluginTheme {
  mode: PluginThemeMode;
  tokens: Record<string, string>;
}

export type PluginHostPlatform = "macos" | "windows" | "linux";

export interface PluginInit {
  protocol: typeof PLUGIN_PROTOCOL_VERSION;
  theme: PluginTheme;
  /** BCP 47, e.g. "en". */
  locale: string;
  platform: PluginHostPlatform;
  /** Chords Lifer keeps. Inside the page: never bind them; preventDefault and send `shortcut`. */
  reservedShortcuts: ShortcutChord[];
  hostVersion: string;
  visible: boolean;
}

export type NavigateTarget =
  { to: "species"; scientificName: string } | { to: "photo"; photoId: string } | { to: "gallery"; query: string };

export interface PluginNotice {
  title: string;
  body?: string;
  /** Label of the notice's one button, which opens the plugin's page. */
  action?: string;
}

type Envelope<T extends string, P> = { lifer: 1; type: T; id?: string; payload: P };

/** What the page sends. Send an `id` to get exactly one `reply`; pickers require one. */
export type PluginToHostMessage =
  | Envelope<"ready", { protocol: number }>
  | Envelope<"shortcut", ShortcutChord>
  | Envelope<"navigate", NavigateTarget>
  | Envelope<"title", { text: string }>
  | Envelope<"pickFolder", { title?: string }>
  | Envelope<"pickFiles", { title?: string }>
  | Envelope<"reveal", { path: string }>
  | Envelope<"openUrl", { url: string }>
  | Envelope<"notify", PluginNotice>
  /**
   * Optional. Send after a `theme` message has been applied and painted. Lifer dissolves the window
   * from the old look to the new, and waits up to 150 ms for this so the page is already in its new
   * theme when the dissolve starts. Pages that never send it just miss that dissolve.
   */
  | Envelope<"themeApplied", Record<string, never>>
  /** Needs the `host.preference` capability in the manifest. Replies `{ openInHost }`. */
  | Envelope<"host.preference.get", Record<string, never>>
  /**
   * Asks the person to turn "Open inside Lifer from now on" on or off. Replies `{ granted, openInHost }`
   * once they answer; Not now (or no answer in 5 minutes) changes nothing. Lifer never changes it by itself.
   */
  | Envelope<"host.preference.request", { openInHost: boolean }>;

export type PluginMessageType = PluginToHostMessage["type"];

/**
 * Why a request failed. `not-allowed`: the manifest lacks the capability (pickers, notifications)
 * or the user turned it off. `invalid`: a known type with a bad payload. `timeout`: no answer in 30 s.
 */
export type PluginErrorCode = "not-allowed" | "invalid" | "not-found" | "unsupported" | "failed" | "timeout";

/** pickFolder: a path or null (cancelled). pickFiles: paths or null. Everything else: null. */
export interface HostPreference {
  openInHost: boolean;
}
export interface HostPreferenceDecision extends HostPreference {
  granted: boolean;
}
export type PluginReplyResult = string | string[] | HostPreference | HostPreferenceDecision | null;

/** host.preference.get and .request: the objects above. */
export type PluginReply = { ok: true; result: PluginReplyResult } | { ok: false; error: PluginErrorCode };

/**
 * What Lifer sends. `credential` is the only secret: the READY line's pageToken, sent right before
 * every `init`, so only after a valid `ready` from the page Lifer framed, and only to its origin.
 * Accept it only when `event.source === window.parent`; keep it in memory, never in the URL or storage.
 */
export type HostToPluginMessage =
  | Envelope<"credential", { token: string }>
  | Envelope<"init", PluginInit>
  | Envelope<"theme", PluginTheme>
  | Envelope<"locale", { locale: string }>
  | Envelope<"visibility", { visible: boolean }>
  | Envelope<"droppedPaths", { paths: string[] }>
  /** The person flipped the setting in Lifer. Sent only to a page that used host.preference.get or .request. */
  | Envelope<"host.preference.changed", HostPreference>
  | { lifer: 1; type: "reply"; id: string; payload: PluginReply };

/** Requests that wait on the user, so the 30 s reply limit doesn't apply. */
export const PLUGIN_INTERACTIVE_TYPES: readonly PluginMessageType[] = [
  "pickFolder",
  "pickFiles",
  "host.preference.request",
];
export const PLUGIN_REPLY_TIMEOUT_MS = 30_000;

// Generous caps: enough for any real value, small enough that a runaway page can't flood the host.
const MAX_TEXT = 200;
const MAX_BODY = 1000;
const MAX_PATH = 4096;
const MAX_URL = 2048;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number, min = 1): v is string =>
  typeof v === "string" && v.length >= min && v.length <= max;
const optStr = (v: unknown, max: number) => v === undefined || str(v, max, 0);
const bool = (v: unknown): v is boolean => typeof v === "boolean";

function validPayload(type: string, p: Record<string, unknown>): boolean {
  switch (type) {
    case "ready":
      return Number.isInteger(p.protocol);
    case "shortcut":
      return (
        str(p.key, 32) &&
        (p.code === undefined || str(p.code, 32)) &&
        bool(p.meta) &&
        bool(p.ctrl) &&
        bool(p.alt) &&
        bool(p.shift)
      );
    case "navigate":
      return (
        (p.to === "species" && str(p.scientificName, MAX_TEXT)) ||
        (p.to === "photo" && str(p.photoId, 64)) ||
        (p.to === "gallery" && str(p.query, MAX_TEXT, 0))
      );
    case "title":
      return str(p.text, MAX_TEXT, 0);
    case "pickFolder":
    case "pickFiles":
      return optStr(p.title, MAX_TEXT);
    case "reveal":
      return str(p.path, MAX_PATH);
    case "openUrl":
      return str(p.url, MAX_URL);
    case "themeApplied":
    case "host.preference.get":
      return true;
    case "host.preference.request":
      return bool(p.openInHost);
    case "notify":
      return str(p.title, MAX_TEXT) && optStr(p.body, MAX_BODY) && optStr(p.action, 40);
    default:
      return false;
  }
}

const KNOWN = new Set<string>([
  "ready",
  "shortcut",
  "navigate",
  "title",
  "pickFolder",
  "pickFiles",
  "reveal",
  "openUrl",
  "notify",
  "themeApplied",
  "host.preference.get",
  "host.preference.request",
]);

// Requests that only make sense with an answer.
const PLUGIN_NEEDS_ID = new Set<string>(["pickFolder", "pickFiles", "host.preference.get", "host.preference.request"]);

export type ParsedPluginMessage =
  | { ok: true; message: PluginToHostMessage }
  /** A known type with a bad payload: worth an `invalid` reply when it carries an id. */
  | { ok: false; id: string | undefined };

/**
 * Validates one message from a page. Returns null for anything that isn't a version 1 message of a
 * known type, which the host ignores without a reply.
 */
export function parsePluginMessage(data: unknown): ParsedPluginMessage | null {
  if (!isObj(data) || data.lifer !== PLUGIN_PROTOCOL_VERSION || typeof data.type !== "string") return null;
  if (!KNOWN.has(data.type)) return null;
  const id = str(data.id, 64) ? data.id : undefined;
  if ((data.id !== undefined && id === undefined) || !isObj(data.payload)) return { ok: false, id };
  if (!validPayload(data.type, data.payload)) return { ok: false, id };
  if (PLUGIN_NEEDS_ID.has(data.type) && id === undefined) return { ok: false, id };
  return { ok: true, message: data as PluginToHostMessage };
}

/** True when a pressed chord is the reserved one. */
export function chordMatches(chord: ShortcutChord, pressed: ShortcutChord): boolean {
  const sameKey = chord.code ? pressed.code === chord.code : pressed.key.toLowerCase() === chord.key.toLowerCase();
  return (
    sameKey &&
    pressed.meta === chord.meta &&
    pressed.ctrl === chord.ctrl &&
    pressed.alt === chord.alt &&
    pressed.shift === chord.shift
  );
}

/** A keydown event as a chord, for the page's `shortcut` message. */
export function chordFromEvent(e: {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): ShortcutChord {
  return { key: e.key, code: e.code, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey };
}
