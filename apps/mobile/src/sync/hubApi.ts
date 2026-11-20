// Talks to the paired hub: device key in x-api-key, the system trust store for a server and the
// pinned-certificate client for a desktop (connection/pinnedFetch.ts). Tries the last address that
// answered, then the others.
import type { PairedHub, Transport } from "../connection/pair";

export class HubError extends Error {
  constructor(readonly status: number) {
    super(`hub answered ${status}`);
  }
}
export class HubUnreachable extends Error {
  constructor() {
    super("hub unreachable");
  }
}

export interface HubApi {
  get<T>(path: string, timeoutMs?: number): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  /** For media downloads: the full URL and headers of a hub path, on the address that last answered. */
  target(path: string): { url: string; headers: Record<string, string>; certSha256?: string };
  readonly kind: "desktop" | "server";
}

export function createHubApi(paired: PairedHub, transport: Transport): HubApi {
  const urls = [paired.hub.baseUrl, ...paired.hub.fallbackUrls];
  let good = 0;
  const headers = { "x-api-key": paired.token, "x-lifer-client": "1", accept: "application/json" };
  const pin = paired.hub.certSha256 ? { certSha256: paired.hub.certSha256 } : {};

  async function call<T>(method: "GET" | "POST", path: string, body: unknown, timeoutMs: number): Promise<T> {
    for (let i = 0; i < urls.length; i++) {
      const at = (good + i) % urls.length;
      let res;
      try {
        res = await transport({
          url: `${urls[at]}/api${path}`,
          method,
          headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          ...pin,
          timeoutMs,
        });
      } catch {
        continue;
      }
      good = at;
      if (res.status < 200 || res.status >= 300) throw new HubError(res.status);
      try {
        return JSON.parse(res.body) as T;
      } catch {
        throw new HubError(502);
      }
    }
    throw new HubUnreachable();
  }

  return {
    kind: paired.hub.kind,
    get: (path, timeoutMs = 20_000) => call("GET", path, undefined, timeoutMs),
    post: (path, body) => call("POST", path, body, 30_000),
    target: (path) => ({ url: `${urls[good]}/api${path}`, headers, ...pin }),
  };
}
