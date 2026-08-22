// Wikimedia's REST/Commons APIs burst-rate-limit anonymous traffic (confirmed by hand —
// requests that succeed in isolation started 429ing once several fetch scripts had already
// hit related Wikimedia infra earlier in the same pipeline run). A fixed delay between calls
// isn't enough on its own; retrying a 429 with backoff is what actually recovers.

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastResponse: Response | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429) return res;
    lastResponse = res;
    const retryAfterHeader = Number(res.headers.get("retry-after"));
    const delayMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
      ? retryAfterHeader * 1000
      : BASE_DELAY_MS * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return lastResponse!;
}
