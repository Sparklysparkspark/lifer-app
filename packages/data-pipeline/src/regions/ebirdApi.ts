// The eBird API at the pace its key allows: 500 requests an hour, and past that it can answer an
// empty list instead of 429, which would read as "no birds here". Shared by every script that
// calls it, so one process never outruns the limit.
const REQUEST_GAP_MS = 7500;
let lastRequest = 0;
let requests = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Requests made by this process so far. */
export const ebirdRequests = () => requests;

/** A JSON array from api.ebird.org/v2/{path}, or null when eBird has no such region or species.
 *  Throws once the hourly limit or an outage outlasts the retries. */
export async function ebirdGet<T>(apiPath: string, key: string): Promise<T[] | null> {
  const url = `https://api.ebird.org/v2/${apiPath}`;
  for (let attempt = 0; ; attempt++) {
    await sleep(Math.max(0, lastRequest + REQUEST_GAP_MS - Date.now()));
    lastRequest = Date.now();
    requests++;
    const res = await fetch(url, { headers: { "X-eBirdApiToken": key } });
    if (res.status === 400 || res.status === 404) return null;
    const body: unknown = res.ok ? await res.json() : null;
    const spent = /"policy";r=0\b/.test(res.headers.get("ratelimit") ?? "");
    if (res.ok && !(spent && Array.isArray(body) && body.length === 0)) {
      if (!Array.isArray(body)) throw new Error(`eBird ${apiPath}: unexpected response`);
      return body as T[];
    }
    if (attempt >= 3 || (!res.ok && res.status !== 429 && res.status < 500))
      throw new Error(`eBird ${apiPath}: ${res.ok ? "hourly limit spent" : `HTTP ${res.status}`}`);
    await sleep(60_000 * 2 ** attempt);
  }
}
