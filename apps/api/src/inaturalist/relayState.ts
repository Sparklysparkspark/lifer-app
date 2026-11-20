// The OAuth `state` for the relay redirect: `<random>.<base64url origin>`. The relay page
// (docs/static/inat-callback/index.html) mirrors decodeRelayState and isAllowedReturnOrigin,
// since a static page can't import this; relayState.test.ts runs both against the same cases.

const PRIVATE_IPV4 = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/** http(s) origin only, nothing after it; plain http only where it can't leave the local network. */
export function isAllowedReturnOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  // URL drops paths, queries and credentials from .origin, so any of them makes this differ.
  if (url.origin !== origin) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  const host = url.hostname;
  if (host === "localhost" || host === "[::1]" || host.endsWith(".local")) return true;
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) && PRIVATE_IPV4.test(host);
}

export function encodeRelayState(random: string, origin: string): string {
  return `${random}.${Buffer.from(origin).toString("base64url")}`;
}

/** The return origin a state carries, or null when it carries none or one the page would refuse. */
export function decodeRelayState(state: string): string | null {
  const dot = state.indexOf(".");
  if (dot < 1) return null;
  const origin = Buffer.from(state.slice(dot + 1), "base64url").toString();
  return isAllowedReturnOrigin(origin) ? origin : null;
}
