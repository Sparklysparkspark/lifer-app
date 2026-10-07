// Re-runnable backfill: each species' global GBIF occurrence count and most recent occurrence
// year, for the "hide obscure/inaccessible species" filter's historical-rarity rule
// (species_traits.occurrence_count < 20 or last_occurrence_year < 1950, see migration 036) and the
// Ghost/Lost tags. GBIF's records reach back to 1800s specimens, unlike iNaturalist's modern-only
// counts, so it can tell "never photographed" from "gone from the record".
//
// Species are fetched in bulk, many per request, grouped by order (see
// pipeline/occurrenceStats.ts for how the results stay equal to one call per species). Each
// species GBIF answered for is stamped in occurrence_checked_at, including those with no records
// (stored as 0, no year), and skipped until the stamp is older than --recheck-after-days. If GBIF
// keeps answering 429, the run stops and the next one carries on.
//
// Usage: npx tsx src/scripts/fetch-occurrence-stats.ts [--only-missing] [--recheck-after-days=90]
//          [--limit=N] [--batch-size=200] [--interval-ms=1000]
import { pool } from "../db.js";
import {
  DEFAULT_BATCH_SIZE,
  GbifOccurrenceClient,
  packGroups,
  RateLimitStop,
  resolveGroup,
  type ResolveMethod,
} from "../pipeline/occurrenceStats.js";
import {
  saveOccurrenceStats,
  selectOccurrenceTargets,
  stampOccurrenceChecked,
  type OccurrenceTarget,
  type StatsUpdate,
} from "../pipeline/occurrenceStatsStore.js";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

function numberArg(name: string, fallback: number): number {
  const value = Number(arg(name) ?? fallback);
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be a non-negative number`);
  return value;
}

async function main() {
  const onlyMissing = process.argv.includes("--only-missing");
  const recheckAfterDays = numberArg("recheck-after-days", 90);
  const limit = arg("limit") ? numberArg("limit", 0) : null;
  const batchSize = Math.max(1, numberArg("batch-size", DEFAULT_BATCH_SIZE));
  const intervalMs = numberArg("interval-ms", 1000);

  const targets = await selectOccurrenceTargets(pool, { onlyMissing, recheckAfterDays, limit });
  const byGroup = new Map<string, OccurrenceTarget[]>();
  for (const t of targets) byGroup.set(t.group_name, [...(byGroup.get(t.group_name) ?? []), t]);
  const sets = packGroups([...byGroup.values()], batchSize);
  console.log(
    `[fetch-occurrence-stats] ${targets.length} species to check in ${byGroup.size} groups (${sets.length} sets)`,
  );

  const client = new GbifOccurrenceClient({ intervalMs });
  const started = Date.now();
  const byMethod: Record<ResolveMethod, number> = { bulk: 0, none: 0, single: 0 };
  let saved = 0;
  let failed = 0;
  let stopped = false;

  for (const rows of sets) {
    const groupNames = [...new Set(rows.map((r) => r.group_name))];
    const label = groupNames.length === 1 ? groupNames[0] : `${groupNames.length} small groups (${groupNames[0]}...)`;
    const byKey = new Map(rows.map((r) => [r.gbif_key, r]));
    const pending: StatsUpdate[] = [];
    const stamp: string[] = [];
    const flush = async () => {
      await saveOccurrenceStats(pool, pending.splice(0));
      await stampOccurrenceChecked(pool, stamp.splice(0));
    };
    const before = client.requests;
    try {
      await resolveGroup([...byKey.keys()], client, {
        now: new Date().getFullYear(),
        batchSize,
        onResolved: (r) => {
          byMethod[r.method]++;
          saved++;
          pending.push({ speciesId: byKey.get(r.gbifKey)!.species_id, stats: r.stats });
        },
        onFailed: (f) => {
          failed++;
          console.error(`  ${byKey.get(f.gbifKey)!.scientific_name} (gbifKey=${f.gbifKey}): ${f.error.message}`);
          // A network error or 5xx is retried next run; any other error waits like a checked species.
          if (!f.error.transient) stamp.push(byKey.get(f.gbifKey)!.species_id);
        },
      });
    } catch (err) {
      if (!(err instanceof RateLimitStop)) throw err;
      stopped = true;
    }
    await flush();
    console.log(`[fetch-occurrence-stats] ${label}: ${rows.length} species, ${client.requests - before} requests`);
    if (stopped) {
      console.warn("[fetch-occurrence-stats] GBIF is refusing most requests (429); stopping. The next run carries on.");
      break;
    }
  }

  const minutes = ((Date.now() - started) / 60000).toFixed(1);
  console.log(
    `[fetch-occurrence-stats] done in ${minutes} min. ${saved} saved (${byMethod.bulk} bulk, ${byMethod.none} with no records, ` +
      `${byMethod.single} per-species), ${failed} failed, ${client.requests} requests (${client.rateLimited} answered 429).`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
