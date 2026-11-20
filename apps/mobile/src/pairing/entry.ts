// Turns what the person typed into a pairing request: the 6 digits alone for a computer (found on
// the Wi-Fi, see pairWithCode), or the digits with a server address.
import { PAIRING_CODE_PATTERN, type CompanionPairingPayload } from "@lifer/shared";

const CODE = new RegExp(PAIRING_CODE_PATTERN);

/** Spaces and dashes removed, so "482 913" works. */
export const normalizeCode = (raw: string): string => raw.replace(/[\s-]/g, "");

export type TypedPairing = { kind: "computer"; code: string } | { kind: "server"; payload: CompanionPairingPayload };

/**
 * A server address without a scheme means HTTPS. The instance id is unknown when typing, so it
 * stays empty and pairing skips that comparison; the server's TLS identifies it.
 */
export function typedPairing(rawCode: string, serverAddress: string): TypedPairing | null {
  const code = normalizeCode(rawCode);
  if (!CODE.test(code)) return null;
  const addr = serverAddress.trim();
  if (!addr) return { kind: "computer", code };
  if (addr.length > 200) return null;
  const address = /^https?:\/\//i.test(addr) ? addr : `https://${addr}`;
  return { kind: "server", payload: { v: 1, kind: "server", instanceId: "", addresses: [address], code } };
}
