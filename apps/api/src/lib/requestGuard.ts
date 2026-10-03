// Request checks run from index.ts's onRequest hooks. Pure functions over headers so they can be
// unit tested without a server.

type Headers = Record<string, string | string[] | undefined>;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ALLOWED_FETCH_SITES = new Set(["same-origin", "none"]);

function header(headers: Headers, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when a state-changing request must be refused as possibly cross-site. A page on another
 * site can't add custom headers without a CORS preflight (which this server never answers), so
 * requiring x-lifer-client blocks form posts and "simple" fetches. An x-api-key request is an
 * API client, not a browser riding a cookie, so it's exempt; route auth still verifies the key.
 * `allowedHosts` are the hosts this server answers as (the Host header, a trusted forwarded host).
 */
export function isBlockedCrossSiteWrite(method: string, headers: Headers, allowedHosts: Array<string | undefined>): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  if (header(headers, "x-api-key")) return false;
  if (header(headers, "x-lifer-client") !== "1") return true;

  const fetchSite = header(headers, "sec-fetch-site");
  if (fetchSite !== undefined) {
    if (!ALLOWED_FETCH_SITES.has(fetchSite.toLowerCase())) return true;
    // The browser itself vouches for same-origin here; skipping the Origin/Host comparison keeps
    // dev (Vite's changeOrigin proxy) and proxies that rewrite Host working.
    return false;
  }

  const origin = header(headers, "origin");
  if (origin === undefined) return false;
  const originHost = hostOf(origin);
  if (!originHost) return true;
  return !allowedHosts.some((h) => h && h.trim().toLowerCase() === originHost);
}

const FORWARDED_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded"];

/** Desktop mode has no proxy in front of it, so any forwarded header means it's being relayed. */
export function hasForwardedHeaders(headers: Headers): boolean {
  return FORWARDED_HEADERS.some((name) => headers[name] !== undefined);
}

/** Hides share tokens in logged URLs: a token in a log is as good as the link itself. */
export function redactShareTokens(url: string): string {
  return url.replace(/\/(shares?)\/[^/?#]+/g, (_m, seg: string) => `/${seg}/[redacted]`);
}
