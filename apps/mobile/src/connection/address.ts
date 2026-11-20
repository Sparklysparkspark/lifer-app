// Turns the addresses in a pairing payload, or what discovery found, into places the phone may call.
import type { FoundHub } from "./pair";

/** Private-network hosts: where plain HTTP to a server is allowed (same rule as the desktop link key). */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".local")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return (
      a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
    );
  }
  return h.includes(":") && (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:"));
}

/**
 * A desktop is always HTTPS with a pinned certificate. A server is HTTPS, or HTTP only on a private
 * address. Returns null for anything else (the address is skipped, never downgraded).
 */
export function baseUrl(address: string, kind: "desktop" | "server"): string | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? address : `https://${address}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && kind === "server" && isPrivateHost(url.hostname)) return url.origin;
  return null;
}

/** What answered on the local network; only private IPv4 hosts, since the listener binds nothing else. */
export function toFoundHubs(raw: unknown): FoundHub[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r: { host?: unknown; port?: unknown; id?: unknown }) =>
    typeof r?.host === "string" &&
    /^\d{1,3}(\.\d{1,3}){3}$/.test(r.host) &&
    isPrivateHost(r.host) &&
    Number.isInteger(r.port) &&
    (r.port as number) > 0 &&
    (r.port as number) < 65536 &&
    typeof r.id === "string" &&
    r.id.length > 0 &&
    r.id.length <= 64
      ? [{ host: r.host, port: r.port as number, instanceId: r.id }]
      : [],
  );
}
