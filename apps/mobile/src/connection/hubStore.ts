// The paired hub and its device key live together in the platform secure store
// (iOS Keychain, Android Keystore), never in plain storage.
import type { Hub, PairedHub } from "./pair";

export interface SecureKv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

const KEY = "lifer.hub.v1";

export async function saveHub(kv: SecureKv, paired: PairedHub): Promise<void> {
  await kv.set(KEY, JSON.stringify(paired));
}

export async function loadHub(kv: SecureKv): Promise<PairedHub | null> {
  const raw = await kv.get(KEY);
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as PairedHub;
    return typeof o?.token === "string" && typeof o.hub?.instanceId === "string" ? o : null;
  } catch {
    return null;
  }
}

/** Unpair on the phone. The hub's copy is revoked from its Connect phone settings. */
export const forgetHub = (kv: SecureKv): Promise<void> => kv.remove(KEY);

export type { Hub };
