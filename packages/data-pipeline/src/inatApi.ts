// iNaturalist's public API at its polite pace: one request about a second, a minute's wait on
// 429 (being throttled), and a few retries on anything else. For pipeline scripts only.
const UA = { "User-Agent": "lifer-app/0.1 (catalog completeness)" };

let lastRequest = 0;

export async function inatGet<T>(url: string): Promise<T> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = 1050 - (Date.now() - lastRequest);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequest = Date.now();
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(60_000) });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 60_000));
        continue;
      }
      if (res.ok) return (await res.json()) as T;
    } catch {
      // retried below
    }
    await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
  }
  throw new Error(`iNaturalist request failed: ${url}`);
}
