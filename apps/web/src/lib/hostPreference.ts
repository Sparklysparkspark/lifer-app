// A connected app's "open inside Lifer from now on" preference (api plugins/hostPreference.ts).
// Changes made in this window are announced, so the app's frame hears host.preference.changed.
import type { HostPreference } from "@lifer/shared";
import { api, apiPath } from "../api/client";

const EVENT = "lifer:host-preference";
type Change = { pluginId: string; openInHost: boolean };

export function announceHostPreference(pluginId: string, openInHost: boolean): void {
  window.dispatchEvent(new CustomEvent<Change>(EVENT, { detail: { pluginId, openInHost } }));
}

export function onHostPreference(pluginId: string, fn: (pref: HostPreference) => void): () => void {
  const listener = (e: Event) => {
    const { detail } = e as CustomEvent<Change>;
    if (detail.pluginId === pluginId) fn({ openInHost: detail.openInHost });
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}

const path = (pluginId: string) => apiPath("/plugins/v1/apps/{pluginId}/host-preference", { pluginId });

export const getHostPreference = (pluginId: string) => api.get(path(pluginId));

export async function setHostPreference(pluginId: string, openInHost: boolean): Promise<HostPreference> {
  const pref = await api.put(path(pluginId), { openInHost });
  announceHostPreference(pluginId, pref.openInHost);
  return pref;
}

/** Shows the confirm dialog (PairingConsentModal) and resolves once the person answered. */
export async function askHostPreference(pluginId: string, openInHost: boolean) {
  const decision = await api.post(apiPath("/plugins/v1/apps/{pluginId}/host-preference/request", { pluginId }), {
    openInHost,
  });
  if (decision.granted) announceHostPreference(pluginId, decision.openInHost);
  return decision;
}
