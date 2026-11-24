import type { TFunction } from "i18next";
import type { ApiBody } from "../api/client";

// What a connected app or an API key may do, worded the same wherever it is granted or reviewed
// (pairing, the offer page, Connected apps, API keys; ux-rules W12).

export type KeyScope = ApiBody<"/api-keys", "post">["permissions"][number];

// One row per resource with Read/Write columns. Keep in sync with API_KEY_SCOPES in
// apps/api/src/auth/apiKeyRoutes.ts, the source of truth.
export const SCOPE_GROUPS: Array<{ labelKey: string; read?: KeyScope; write?: KeyScope }> = [
  { labelKey: "apiKeys.scopes.gallery", read: "gallery.read" },
  { labelKey: "apiKeys.scopes.species", read: "species.read" },
  { labelKey: "apiKeys.scopes.stats", read: "stats.read" },
  { labelKey: "apiKeys.scopes.trips", read: "trips.read" },
  { labelKey: "apiKeys.scopes.albums", read: "album.read", write: "album.write" },
  { labelKey: "apiKeys.scopes.shares", read: "share.read", write: "share.write" },
  // Integrations (see the API guide): read = photo feed + image files; write = imports + photo edits.
  { labelKey: "apiKeys.scopes.photos", read: "photos.read", write: "photos.write" },
  // write = adding species to region checklists yourself.
  { labelKey: "apiKeys.scopes.lifeList", read: "collection.read", write: "collection.write" },
  // Companion apps: your own marks and photos with no catalog data (write = ratings, featured photos and
  // the "needs a better photo" mark); importing new photos.
  { labelKey: "apiKeys.scopes.yourData", read: "userdata.read", write: "userdata.write" },
  { labelKey: "apiKeys.scopes.imports", write: "imports.write" },
  { labelKey: "apiKeys.scopes.openData", read: "opendata.read" },
];

// The scopes a connected app asks for, as a person reads them.
const APP_SCOPE_KEYS: Record<string, string> = {
  "userdata.read": "connectedApps.scope.yourData",
  "userdata.write": "connectedApps.scope.yourDataWrite",
  "imports.write": "connectedApps.scope.imports",
  "opendata.read": "connectedApps.scope.openData",
  "host.preference": "connectedApps.scope.hostPreference",
};

// The fuller explanation under a label when an app asks for it, for scopes whose label can't say it all.
const APP_SCOPE_DETAIL_KEYS: Record<string, string> = {
  "userdata.write": "pairing.scopes.userdataWrite",
};

/** A connected app's scope in plain words; anything unknown shows as its id. */
export function appScopeLabel(t: TFunction, scope: string): string {
  return APP_SCOPE_KEYS[scope] ? t(APP_SCOPE_KEYS[scope]) : scope;
}

/** The longer explanation for a scope when an app asks for it, or null when the label says it all. */
export function appScopeDetail(t: TFunction, scope: string): string | null {
  return APP_SCOPE_DETAIL_KEYS[scope] ? t(APP_SCOPE_DETAIL_KEYS[scope]) : null;
}

/** An API key permission as "Albums: Write"; anything unknown shows as its id. */
export function keyScopeLabel(t: TFunction, scope: string): string {
  for (const g of SCOPE_GROUPS) {
    if (g.read === scope) return t("apiKeys.permission", { resource: t(g.labelKey), access: t("apiKeys.form.read") });
    if (g.write === scope) return t("apiKeys.permission", { resource: t(g.labelKey), access: t("apiKeys.form.write") });
  }
  return scope;
}
