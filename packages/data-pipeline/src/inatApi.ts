// iNaturalist's taxa API through the shared HTTP client: paced with every other iNaturalist call
// in the process, a 429 holding iNaturalist for all of them, and a few retries on anything else.
// For pipeline scripts only.
import { httpFetch } from "@lifer/core/lib/http.js";
import { expectShape, isInatTaxaPage } from "./lib/jsonGuards.js";

/** A /v1/taxa response (by id or by search). An unexpected body fails at once rather than retrying. */
export async function inatGet<T extends { results: Array<{ id: number; name: string }> }>(url: string): Promise<T> {
  let body: unknown;
  try {
    const res = await httpFetch(url, {
      timeoutMs: 60_000,
      maxRetries: 5,
      retryServerErrors: true,
      backoffBaseMs: 5000,
    });
    if (res.ok) body = await res.json();
  } catch {
    // reported below
  }
  if (body === undefined) throw new Error(`iNaturalist request failed: ${url}`);
  return expectShape(body, isInatTaxaPage, "iNaturalist taxa") as T;
}
