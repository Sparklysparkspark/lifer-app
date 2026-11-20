// The server this desktop install is linked to, as the desktop shell records it in
// APP_DATA_DIR/server-link.json (apps/desktop/src-tauri/src/server_link.rs): the server's
// instance id, the addresses to try, and the API key the shell got for this app. Read fresh on
// every use, since the shell writes it after the window signs in and removes it on sign-out.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import path from "node:path";
import { APP_DATA_DIR } from "@lifer/core/config.js";
import { proofMatches } from "./linkProof.js";

export interface ServerLink {
  instanceId: string;
  urls: string[];
  token: string;
  /** The key's id on the server, and the secret that server proves itself with (linkProof.ts). */
  keyId?: string;
  linkSecret?: string;
}

export interface LinkedServer extends ServerLink {
  /** The address that answered with the link's instance id. */
  baseUrl: string;
}

export function readServerLink(dir: string = APP_DATA_DIR): ServerLink | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, "server-link.json"), "utf8")) as Partial<ServerLink>;
    if (typeof raw.instanceId !== "string" || typeof raw.token !== "string" || !Array.isArray(raw.urls)) return null;
    return {
      instanceId: raw.instanceId,
      token: raw.token,
      urls: raw.urls.filter((u) => typeof u === "string"),
      ...(typeof raw.keyId === "string" && typeof raw.linkSecret === "string"
        ? { keyId: raw.keyId, linkSecret: raw.linkSecret }
        : {}),
    };
  } catch {
    return null;
  }
}

const localNetwork = new BlockList();
for (const [net, bits] of [
  ["127.0.0.0", 8],
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["169.254.0.0", 16],
  ["100.64.0.0", 10],
] as const)
  localNetwork.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
] as const)
  localNetwork.addSubnet(net, bits, "ipv6");

/** Whether the key may go to this address: https, or plain http that stays on this computer or
 *  the local network (the same rule as the desktop shell's, security.rs is_secure_origin). The
 *  instance id that picks the address is public, so on plain http over the internet anyone on
 *  the path could answer as the server and take the key. */
export function keyMayGoTo(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  if (u.protocol !== "http:") return false;
  const host = u.hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
  const family = isIP(host);
  if (family) return localNetwork.check(host, family === 4 ? "ipv4" : "ipv6");
  // Names only a local resolver answers: single labels like "nas", and suffixes kept for local networks.
  return !host.includes(".") || [".local", ".lan", ".home.arpa", ".internal"].some((s) => host.endsWith(s));
}

/** Whether the server at `base` answers a fresh nonce with the proof only the linked server can make.
 *  A link without a secret (made before servers proved themselves) is taken on its instance id. */
async function provesItself(link: ServerLink, base: string): Promise<boolean> {
  if (!link.keyId || !link.linkSecret) return true;
  const nonce = randomBytes(16).toString("hex");
  const res = await fetch(`${base}/api/sync/link/proof?keyId=${link.keyId}&nonce=${nonce}`, {
    signal: AbortSignal.timeout(4000),
    redirect: "error",
  });
  if (!res.ok) return false;
  const body = (await res.json()) as { proof?: unknown };
  return typeof body.proof === "string" && proofMatches(link.linkSecret, nonce, body.proof);
}

/** The linked server at the first of its addresses that answers as that server, or null. */
export async function linkedServer(link: ServerLink | null = readServerLink()): Promise<LinkedServer | null> {
  if (!link) return null;
  for (const url of link.urls) {
    if (!keyMayGoTo(url)) continue;
    const base = url.replace(/\/+$/, "");
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) continue;
      const body = (await res.json()) as { instanceId?: string | null };
      if (body.instanceId === link.instanceId && (await provesItself(link, base))) return { ...link, baseUrl: base };
    } catch {
      // Try the next address.
    }
  }
  return null;
}

/** Throws once the link this job started with is gone (signed out, or another server). */
export function assertStillLinked(server: LinkedServer): void {
  if (readServerLink()?.token !== server.token) throw new Error("This app is no longer linked to that server");
}

/** A request to the linked server's API with this app's key. */
export function serverFetch(server: LinkedServer, apiPath: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${server.baseUrl}/api${apiPath}`, {
    ...init,
    // The key goes only to the linked address, never on to wherever a redirect points.
    redirect: "error",
    headers: {
      "x-api-key": server.token,
      // The API's cross-site guard wants this on non-GET requests from Lifer's own clients.
      "x-lifer-client": "1",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    signal: init.signal ?? AbortSignal.timeout(60_000),
  });
}
