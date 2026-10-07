// Packs can only include photos whose license lets Lifer redistribute them, so thousands of species
// ship without one although iNaturalist has a photo (species.photo_withheld, migration 123). For
// species on a checklist this install downloaded a pack for, this fetches that main photo from
// iNaturalist in the background, for personal viewing, the same way opening the species online
// would. Only the main photo, never the gallery, to go easy on iNaturalist and the disk.
//
// Polite by design: one species at a time, a pause between species on top of lazyEnrich's
// per-host pacing, a daily cap, and a stop when iNaturalist keeps rate-limiting or failing (it
// resumes an hour later, or on the next start). Every attempt stamps species.photo_checked_at and
// a species is tried again only after RETRY_AFTER_DAYS, so failures never loop.
//
// Runs on startup and after every pack download. An install setting turns it off.
import type { Pool } from "pg";
import { pool } from "@lifer/core/db.js";
import { log } from "@lifer/core/lib/log.js";
import {
  downloadAndCacheImage,
  fetchFirstTaxonPhoto,
  fetchINaturalistTaxon,
  persistMainPhotoIfMissing,
  PersistentRateLimitError,
  toGalleryPhoto,
} from "@lifer/core/species/lazyEnrich.js";
import { getInstallSetting, setInstallSetting } from "../lib/installSettings.js";

export const FETCH_WITHHELD_PHOTOS_SETTING = "fetch_withheld_photos";
/** A species whose fetch didn't give it a photo is tried again after this long. */
export const RETRY_AFTER_DAYS = 30;
/** Between two species, on top of the one second per host lazyEnrich already keeps. */
export const PAUSE_BETWEEN_SPECIES_MS = 2_000;
/** Species tried per rolling 24 hours: up to about 3 iNaturalist requests each. */
export const DAILY_LIMIT = 2_000;
/** Consecutive failures (iNaturalist down, no network) that end a pass. */
export const MAX_CONSECUTIVE_FAILURES = 5;
/** How long a pass that stopped early waits before trying again. */
export const RESUME_AFTER_MS = 60 * 60_000;
const BATCH_SIZE = 50;

export interface WithheldSpecies {
  id: string;
  scientific_name: string;
}

export async function isWithheldPhotoFetchEnabled(db: Pool = pool): Promise<boolean> {
  // On unless turned off.
  return (await getInstallSetting<boolean>(db, FETCH_WITHHELD_PHOTOS_SETTING)) !== false;
}

export async function setWithheldPhotoFetchEnabled(enabled: boolean, db: Pool = pool): Promise<void> {
  await setInstallSetting(db, FETCH_WITHHELD_PHOTOS_SETTING, enabled);
  if (enabled) startWithheldPhotoFetch("turned on");
  else stopWithheldPhotoFetch();
}

/** Species with a withheld photo and none of their own that are on a checklist of a downloaded
 *  pack: its region and the provinces still applied (downloaded_packs.applied_province_region_ids,
 *  NULL meaning all), or its sea zone. Overseas territories and offloaded provinces don't count. */
export async function selectWithheldPhotoSpecies(
  db: Pool,
  limit: number,
  retryAfterDays = RETRY_AFTER_DAYS,
): Promise<WithheldSpecies[]> {
  const res = await db.query<WithheldSpecies>(
    `WITH pack_regions AS (
       SELECT dp.pack_id, r.id AS region_id
         FROM downloaded_packs dp JOIN regions r ON r.name = dp.region
       UNION
       SELECT dp.pack_id, c.id
         FROM downloaded_packs dp
         JOIN regions r ON r.name = dp.region
         JOIN regions c ON c.parent_id = r.id
        WHERE dp.applied_province_region_ids IS NULL OR dp.applied_province_region_ids ? c.id::text
     ),
     pack_zones AS (
       SELECT dp.pack_id, z.id AS sea_zone_id FROM downloaded_packs dp JOIN sea_zones z ON z.name = dp.region
     )
     SELECT s.id, s.scientific_name
       FROM species s
      WHERE s.photo_withheld AND s.reference_photo IS NULL
        AND (s.photo_checked_at IS NULL OR s.photo_checked_at < now() - make_interval(days => $2::int))
        AND EXISTS (
          SELECT 1 FROM pack_species ps
           WHERE ps.species_id = s.id
             AND (
               EXISTS (
                 SELECT 1 FROM pack_regions pr JOIN region_species rs ON rs.region_id = pr.region_id
                  WHERE pr.pack_id = ps.pack_id AND rs.species_id = s.id
               )
               OR EXISTS (
                 SELECT 1 FROM pack_zones pz JOIN sea_zone_species zs ON zs.sea_zone_id = pz.sea_zone_id
                  WHERE pz.pack_id = ps.pack_id AND zs.species_id = s.id
               )
             )
        )
      ORDER BY s.photo_checked_at NULLS FIRST, s.id
      LIMIT $1`,
    [limit, retryAfterDays],
  );
  return res.rows;
}

/** Fetch attempts in the last 24 hours, for DAILY_LIMIT. Catalog seeds never carry
 *  photo_checked_at, so on an install these are its own attempts. */
export async function attemptsInLastDay(db: Pool = pool): Promise<number> {
  const res = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM species WHERE photo_withheld AND photo_checked_at > now() - interval '1 day'`,
  );
  return res.rows[0].n;
}

export async function markPhotoChecked(speciesId: string, db: Pool = pool): Promise<void> {
  await db.query(`UPDATE species SET photo_checked_at = now() WHERE id = $1`, [speciesId]);
}

export type FetchOutcome = "stored" | "none" | "failed";

/** The species' main iNaturalist photo, cached locally and stored with its credit and license.
 *  "none" when iNaturalist has no photo for it, "failed" when the photo couldn't be downloaded.
 *  Throws PersistentRateLimitError when iNaturalist keeps rate-limiting. */
export async function fetchWithheldPhoto(species: WithheldSpecies): Promise<FetchOutcome> {
  const taxon = await fetchINaturalistTaxon(species.scientific_name);
  if (!taxon) return "none";
  // default_photo isn't always flagged even when the taxon has photos.
  const photo = taxon.defaultPhoto ?? (await fetchFirstTaxonPhoto(taxon.id));
  if (!photo) return "none";
  const mapped = toGalleryPhoto(photo);
  // A hotlinked URL would be no use offline, so a failed download stores nothing and is retried.
  const cached = await downloadAndCacheImage(mapped.photoUrl, species.id);
  if (!cached) return "failed";
  const stored = await persistMainPhotoIfMissing(species.id, { ...mapped, ...cached });
  return stored ? "stored" : "none";
}

export interface PassDeps {
  isEnabled(): Promise<boolean>;
  nextBatch(limit: number): Promise<WithheldSpecies[]>;
  attemptsInLastDay(): Promise<number>;
  fetchPhoto(species: WithheldSpecies): Promise<FetchOutcome>;
  markChecked(speciesId: string): Promise<void>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export type PassEnd = "done" | "disabled" | "stopped" | "rate-limited" | "daily-limit" | "failing";
export interface PassResult {
  stored: number;
  none: number;
  failed: number;
  end: PassEnd;
}

/** One pass over everything left, one species at a time, until done or told to stop. */
export async function runWithheldPhotoPass(deps: PassDeps, signal: AbortSignal): Promise<PassResult> {
  const result: PassResult = { stored: 0, none: 0, failed: 0, end: "done" };
  const finish = (end: PassEnd) => ({ ...result, end });
  let budget = DAILY_LIMIT - (await deps.attemptsInLastDay());
  let consecutiveFailures = 0;
  for (;;) {
    const batch = await deps.nextBatch(BATCH_SIZE);
    if (batch.length === 0) return finish("done");
    for (const species of batch) {
      if (signal.aborted) return finish("stopped");
      // Checked before every species, so turning the setting off stops a pass on its next step.
      if (!(await deps.isEnabled())) return finish("disabled");
      if (budget <= 0) return finish("daily-limit");
      let outcome: FetchOutcome;
      try {
        outcome = await deps.fetchPhoto(species);
      } catch (err) {
        // Not stamped: iNaturalist asked us to slow down, which says nothing about the species.
        if (err instanceof PersistentRateLimitError) return finish("rate-limited");
        log.warn({ err, speciesId: species.id }, "Couldn't fetch a withheld reference photo");
        outcome = "failed";
      }
      await deps.markChecked(species.id);
      budget--;
      result[outcome]++;
      consecutiveFailures = outcome === "failed" ? consecutiveFailures + 1 : 0;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return finish("failing");
      await deps.sleep(PAUSE_BETWEEN_SPECIES_MS, signal);
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

const defaultDeps: PassDeps = {
  isEnabled: () => isWithheldPhotoFetchEnabled(),
  nextBatch: (limit) => selectWithheldPhotoSpecies(pool, limit),
  attemptsInLastDay: () => attemptsInLastDay(),
  fetchPhoto: fetchWithheldPhoto,
  markChecked: (speciesId) => markPhotoChecked(speciesId),
  sleep,
};

// One pass at a time. A start while one runs is remembered and runs once it finishes, so a pack
// applied near the end of a pass still gets its photos.
let current: AbortController | null = null;
let currentPass: Promise<void> | null = null;
let startRequested = false;
let resumeTimer: NodeJS.Timeout | null = null;

/** Starts a pass in the background unless one is running or a stopped one is waiting to resume. */
export function startWithheldPhotoFetch(reason: string, deps: PassDeps = defaultDeps): void {
  if (current) {
    startRequested = true;
    return;
  }
  // Waiting out a rate limit or the daily cap: an early start would only meet it again.
  if (resumeTimer) return;
  const controller = new AbortController();
  current = controller;
  startRequested = false;
  currentPass = (async () => {
    let end: PassEnd | "error" = "error";
    try {
      const result = await runWithheldPhotoPass(deps, controller.signal);
      end = result.end;
      if (result.stored + result.none + result.failed > 0 || end !== "done") {
        log.info({ ...result, reason }, "Withheld reference photo fetch pass ended");
      }
    } catch (err) {
      log.warn({ err, reason }, "Withheld reference photo fetch failed");
    } finally {
      current = null;
      currentPass = null;
      const backOff = end === "rate-limited" || end === "daily-limit" || end === "failing" || end === "error";
      if (backOff) {
        resumeTimer = setTimeout(() => {
          resumeTimer = null;
          startWithheldPhotoFetch("resume", deps);
        }, RESUME_AFTER_MS);
        resumeTimer.unref();
      } else if (startRequested) {
        // Includes a start right after a stop (the setting turned off and on again).
        startRequested = false;
        startWithheldPhotoFetch("queued", deps);
      }
      startRequested = false;
    }
  })();
}

/** Stops the running pass at its next step and cancels a scheduled resume. */
export function stopWithheldPhotoFetch(): void {
  current?.abort();
  startRequested = false;
  if (resumeTimer) clearTimeout(resumeTimer);
  resumeTimer = null;
}

/** Resolves once the running pass (if any) has stopped. For tests and shutdown. */
export async function withheldPhotoFetchIdle(): Promise<void> {
  await currentPass;
}
