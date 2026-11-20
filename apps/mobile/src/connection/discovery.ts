// Finds Lifer computers on this Wi-Fi for typed pairing, and the secure random bytes the key
// exchange needs (Hermes has no crypto.getRandomValues). Native side: modules/local-pairing.
import { requireNativeModule } from "expo-modules-core";
import { toFoundHubs } from "./address";
import type { FoundHub } from "./pair";

const SERVICE_TYPE = "_lifer-companion._tcp";

interface Native {
  browse(type: string, timeoutMs: number): Promise<{ host: string; port: number; id: string }[]>;
  randomBytes(count: number): number[];
}

const native = () => requireNativeModule<Native>("LocalPairing");

export const discoverHubs = async (timeoutMs = 3000): Promise<FoundHub[]> =>
  toFoundHubs(await native().browse(SERVICE_TYPE, timeoutMs));

export function nativeRandom(n: number): Uint8Array {
  const bytes = native().randomBytes(n);
  if (bytes.length !== n || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b < 256)) {
    throw new Error("No secure random bytes");
  }
  return Uint8Array.from(bytes);
}
