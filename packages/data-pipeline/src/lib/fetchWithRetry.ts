// Wikimedia and GBIF burst-rate-limit anonymous traffic, and a fixed delay between calls isn't
// enough on its own; retrying a 429 with backoff is what recovers. Every GET is cached by exact
// URL in gbif_response_cache (migration 040), read however old, so recomputing a region after a
// threshold fix reuses the same raw data instead of refetching.
import { httpFetch } from "@lifer/core/lib/http.js";

export async function fetchWithRetry(url: string, init: RequestInit = {}): Promise<Response> {
  const { signal, ...rest } = init;
  return httpFetch(url, {
    init: rest,
    signal: signal ?? undefined,
    maxRetries: 6,
    // Generous, because GBIF's species/search gets very slow at deep pagination offsets (over
    // 90 s for a single page).
    timeoutMs: 180_000,
    cache: { table: "gbif_response_cache" },
  });
}
