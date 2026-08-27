-- Raw external-API response cache, keyed by exact request URL. build-region-species.ts's
-- computeRegionOccurrences makes dozens of GBIF calls per region (species counts, 12 monthly
-- seasonality queries, year facets, record samples) — every time a filtering/threshold BUG gets
-- fixed (e.g. the marine-exclusion-too-aggressive fix), the whole region has to be recomputed,
-- which previously meant re-fetching the exact same raw GBIF data over the network again just
-- to re-derive a different final answer from it. GBIF occurrence data for past years doesn't
-- meaningfully change on the timescale of a single development session, so caching the raw
-- response means every future recompute of an already-fetched region resolves entirely from
-- our own database — no network calls, no rate-limit risk, no waiting on GBIF at all. Cleared
-- deliberately (see clear-gbif-cache.ts) when a genuine fresh pull is wanted, not on a timer.
CREATE TABLE IF NOT EXISTS gbif_response_cache (
  url text PRIMARY KEY,
  response text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
