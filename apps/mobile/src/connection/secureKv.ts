import * as SecureStore from "expo-secure-store";
import type { SecureKv } from "./hubStore";

// Not synced to iCloud Keychain: a device key belongs to this phone alone.
export const secureKv: SecureKv = {
  get: (k) => SecureStore.getItemAsync(k),
  set: (k, v) => SecureStore.setItemAsync(k, v, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
  remove: (k) => SecureStore.deleteItemAsync(k),
};
