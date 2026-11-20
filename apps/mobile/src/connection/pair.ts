// Trades a scanned pairing payload for a device key. The transport is injected: a desktop goes
// through the native pinned-certificate client, a server through the system's trust store.
import { pakeConfirm, pakeHello, type CompanionPairingPayload, type DevicePlatform } from "@lifer/shared";
import { baseUrl } from "./address";

export type PairErrorCode =
  "unreachable" | "not_found" | "code_invalid" | "rate_limited" | "wrong_hub" | "cert_mismatch";

export class PairError extends Error {
  constructor(readonly code: PairErrorCode) {
    super(code);
  }
}

export interface TransportRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  /** Lowercase hex SHA-256 the server certificate must match exactly. Absent: system trust. */
  certSha256?: string;
  /** Accept any certificate and report it: a typed pairing's first request, which carries no secret. */
  captureCert?: boolean;
  timeoutMs: number;
}
export interface TransportResponse {
  status: number;
  body: string;
  /** With captureCert: the SHA-256 of the certificate this request saw. */
  certSha256?: string;
}
/** Throws `{ code: "CERT_MISMATCH" }` on a wrong certificate; any other throw means unreachable. */
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export interface Hub {
  kind: "desktop" | "server";
  instanceId: string;
  /** The address that answered first; the rest stay as fallbacks. */
  baseUrl: string;
  fallbackUrls: string[];
  certSha256?: string;
  deviceId: string;
  scopes: string[];
}
export interface PairedHub {
  hub: Hub;
  token: string;
}

export async function pairWithHub(
  payload: CompanionPairingPayload,
  device: { deviceName: string; platform: DevicePlatform },
  transport: Transport,
  timeoutMs = 5000,
): Promise<PairedHub> {
  const urls = payload.addresses.map((a) => baseUrl(a, payload.kind)).filter((u): u is string => u !== null);
  let failure: PairErrorCode = "unreachable";
  for (const url of urls) {
    let res: TransportResponse;
    try {
      res = await transport({
        url: `${url}/api/companion/v1/pair`,
        method: "POST",
        headers: { "content-type": "application/json", "x-lifer-client": "1" },
        body: JSON.stringify({ code: payload.code, ...device }),
        certSha256: payload.certSha256,
        timeoutMs,
      });
    } catch (e) {
      if ((e as { code?: string }).code === "CERT_MISMATCH") failure = "cert_mismatch";
      continue;
    }
    // A code is single use, so a definite answer from the hub ends the search.
    if (res.status === 429) throw new PairError("rate_limited");
    if (res.status === 401 || res.status === 400) throw new PairError("code_invalid");
    if (res.status !== 200) continue;
    const reply = parseReply(res.body);
    // A typed code has no instance id; the pin or TLS identifies the hub then.
    if (!reply || (payload.instanceId && reply.instanceId !== payload.instanceId)) throw new PairError("wrong_hub");
    return {
      token: reply.token,
      hub: {
        kind: payload.kind,
        instanceId: reply.instanceId,
        baseUrl: url,
        fallbackUrls: urls.filter((u) => u !== url),
        ...(payload.certSha256 ? { certSha256: payload.certSha256 } : {}),
        deviceId: reply.deviceId,
        scopes: reply.scopes,
      },
    };
  }
  throw new PairError(failure);
}

function parseReply(body: string): { deviceId: string; token: string; instanceId: string; scopes: string[] } | null {
  try {
    const o = JSON.parse(body) as Record<string, unknown>;
    const { deviceId, token, instanceId, scopes } = o;
    if (typeof deviceId !== "string" || typeof token !== "string" || typeof instanceId !== "string") return null;
    if (!Array.isArray(scopes) || !scopes.every((s) => typeof s === "string")) return null;
    return { deviceId, token, instanceId, scopes };
  } catch {
    return null;
  }
}

/** A Lifer computer seen on the network by Bonjour or NSD. Its claims are checked by the key exchange. */
export interface FoundHub {
  host: string;
  port: number;
  instanceId: string;
}

const JSON_HEADERS = { "content-type": "application/json", "x-lifer-client": "1" };

/**
 * Typed pairing with a computer: only the 6 digits. Each Lifer found on the network is asked for a
 * key exchange keyed by the code (companionPake.ts); a hub's answer counts only if it proves the
 * code for the certificate this phone saw, and from then on that certificate is pinned. The code
 * itself is never sent, so an impostor on the network gets one guess and nothing to test offline.
 */
export async function pairWithCode(
  code: string,
  device: { deviceName: string; platform: DevicePlatform },
  deps: { transport: Transport; discover: () => Promise<FoundHub[]>; random: (n: number) => Uint8Array },
  timeoutMs = 5000,
): Promise<PairedHub> {
  const found = await deps.discover();
  if (found.length === 0) throw new PairError("not_found");
  let failure: PairErrorCode = "unreachable";
  for (const hub of found) {
    const url = baseUrl(`${hub.host}:${hub.port}`, "desktop");
    if (!url) continue;
    const { hello, secret } = pakeHello(code, deps.random);
    let start: TransportResponse;
    try {
      start = await deps.transport({
        url: `${url}/api/companion/v1/pair/start`,
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(hello),
        captureCert: true,
        timeoutMs,
      });
    } catch {
      continue;
    }
    if (start.status === 429) throw new PairError("rate_limited");
    // No live code there, or one that isn't this one: try the next Lifer.
    if (start.status === 401) failure = "code_invalid";
    if (start.status !== 200 || !start.certSha256) continue;
    const reply = parseStart(start.body);
    const tagA = reply && pakeConfirm(secret, start.certSha256, reply);
    // A wrong code and an impostor look the same here; neither goes further.
    if (!tagA) {
      failure = "code_invalid";
      continue;
    }
    let finish: TransportResponse;
    try {
      finish = await deps.transport({
        url: `${url}/api/companion/v1/pair/finish`,
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ session: reply.session, tagA, ...device }),
        certSha256: start.certSha256,
        timeoutMs,
      });
    } catch (e) {
      if ((e as { code?: string }).code === "CERT_MISMATCH") failure = "cert_mismatch";
      continue;
    }
    if (finish.status === 401) throw new PairError("code_invalid");
    const paired = finish.status === 200 ? parseReply(finish.body) : null;
    if (!paired) continue;
    return {
      token: paired.token,
      hub: {
        kind: "desktop",
        instanceId: paired.instanceId,
        baseUrl: url,
        fallbackUrls: [],
        certSha256: start.certSha256,
        deviceId: paired.deviceId,
        scopes: paired.scopes,
      },
    };
  }
  throw new PairError(failure);
}

function parseStart(body: string): { session: string; yb: string; tagB: string } | null {
  try {
    const { session, yb, tagB } = JSON.parse(body) as Record<string, unknown>;
    if (typeof session !== "string" || typeof yb !== "string" || typeof tagB !== "string") return null;
    return { session, yb, tagB };
  } catch {
    return null;
  }
}

/** The en.json message for a pairing failure. */
export const pairErrorKey = (code: PairErrorCode): string =>
  ({
    unreachable: "connect.errors.unreachable",
    not_found: "connect.errors.notFound",
    code_invalid: "connect.errors.codeInvalid",
    rate_limited: "connect.errors.rateLimited",
    wrong_hub: "connect.errors.wrongHub",
    cert_mismatch: "connect.errors.certMismatch",
  })[code];

/** The kind of hub in plain words, from its payload kind. */
export const hubLabelKey = (kind: Hub["kind"]): string => (kind === "desktop" ? "pair.hub.desktop" : "pair.hub.server");
