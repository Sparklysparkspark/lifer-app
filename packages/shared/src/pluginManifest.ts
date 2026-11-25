// Companion app manifest (schema 1) and what the desktop shell's plugins_list command returns.
// The shell validates manifests (apps/desktop/src-tauri/src/plugins.rs); keep both in step.

/** Lifer drops a capability it doesn't know (one from a newer Lifer) and keeps the manifest. */
export const PLUGIN_CAPABILITIES = [
  "pickers",
  "notifications",
  "imports",
  "offersImports",
  "background",
  "host.preference",
] as const;
export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

export type PluginSurface = "default" | "dark";

/** The sidebar entry: label, a monochrome SVG path, an accent colour value, and the page surface. */
export interface PluginPage {
  label: string;
  icon: string;
  accent: string;
  surface: PluginSurface;
}

/** The JSON file a plugin writes to <app data>/plugins/<id>.json. */
export interface PluginManifest {
  schema: 1;
  /** Reverse-DNS id, e.g. com.example.app. */
  id: string;
  name: string;
  /** Plain https URLs. */
  publisher: string;
  homepage: string;
  support: string;
  version: string;
  /** Absolute path per OS. */
  executable: { darwin?: string; win32?: string; linux?: string };
  /** Host protocol versions it speaks. */
  protocol: number[];
  page: PluginPage;
  /** API scopes it will ask for at pairing. */
  scopes: string[];
  capabilities?: PluginCapability[];
}

/**
 * One row of the shell's plugins_list command. `approved` is false until the user allows the app.
 * Approval is pinned to its code signer, or to the file's hash when it isn't signed.
 */
export interface PluginSummary {
  id: string;
  name: string;
  version: string;
  /** Where its program is on this computer. */
  executable: string;
  page: PluginPage;
  scopes: string[];
  capabilities: PluginCapability[];
  approved: boolean;
}

/**
 * What plugin_start returns. `pageUrl` carries no secret; `pageToken` reaches the page only in the
 * host protocol's `credential` message, so it stays out of history, logs and Referer headers.
 */
export interface PluginEndpoint {
  origin: string;
  pageUrl: string;
  pageToken: string;
}

/** What plugin_status returns. The page asks every 10 s while visible, which also checks health. */
export interface PluginStatus {
  state: "stopped" | "starting" | "running";
  endpoint: PluginEndpoint | null;
  /** Why it stopped, in plain words, when it didn't stop on purpose. */
  error: string | null;
}
