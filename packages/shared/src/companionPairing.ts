// What a phone scans to pair with a desktop or a server. The code is single use and short lived;
// a desktop also sends its certificate fingerprint, so the phone can trust the self-signed listener.
// The same 6 digits are shown under the QR for typing (typed pairing: companionPake.ts).

export const PAIRING_PAYLOAD_VERSION = 1;
export const DEVICE_PLATFORMS = ["ios", "android"] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

export const PAIRING_CODE_LENGTH = 6;
export const PAIRING_CODE_PATTERN = `^[0-9]{${PAIRING_CODE_LENGTH}}$`;

/** "482913" as "482 913", how people read and type it. */
export const groupPairingCode = (code: string): string => `${code.slice(0, 3)} ${code.slice(3)}`;

export interface CompanionPairingPayload {
  v: typeof PAIRING_PAYLOAD_VERSION;
  kind: "desktop" | "server";
  instanceId: string;
  /** Where to reach it, tried in order: "host:port" or a full URL. */
  addresses: string[];
  /** SHA-256 of the desktop listener's certificate, lowercase hex. Absent for a server. */
  certSha256?: string;
  code: string;
}

const MAX_ADDRESSES = 8;
const MAX_ADDRESS_LENGTH = 200;
const HEX64 = /^[0-9a-f]{64}$/;

export const encodePairingPayload = (p: CompanionPairingPayload): string => JSON.stringify(p);

/** The payload in a scanned QR code, or null when it isn't a valid version 1 payload. */
export function parsePairingPayload(text: string): CompanionPairingPayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const { kind, instanceId, addresses, certSha256, code } = o;
  if (o.v !== PAIRING_PAYLOAD_VERSION || (kind !== "desktop" && kind !== "server")) return null;
  if (typeof instanceId !== "string" || !instanceId || instanceId.length > 64) return null;
  if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > MAX_ADDRESSES) return null;
  if (!addresses.every((a) => typeof a === "string" && a.length > 0 && a.length <= MAX_ADDRESS_LENGTH)) return null;
  if (typeof code !== "string" || !new RegExp(PAIRING_CODE_PATTERN).test(code)) return null;
  if (kind === "desktop" ? typeof certSha256 !== "string" || !HEX64.test(certSha256) : certSha256 !== undefined) {
    return null;
  }
  return {
    v: PAIRING_PAYLOAD_VERSION,
    kind,
    instanceId,
    addresses,
    ...(typeof certSha256 === "string" ? { certSha256 } : {}),
    code,
  };
}
