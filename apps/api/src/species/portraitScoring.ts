// Scores reference photos that have a vector but no kind yet (referencePortrait.ts), in small
// transactions in the background: after startup, and hourly for photos whose vectors arrived
// since (packs, catalog updates, vector downloads). Rows already scored are never touched again.
import { log } from "@lifer/core/lib/log.js";
import { scorePendingReferencePhotos } from "@lifer/core/species/referencePortrait.js";

const HOUR_MS = 60 * 60 * 1000;
let running = false;

async function run(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Small batches with a pause between: each batch parses its vectors on the event loop, so a
    // big one would hold up the user's own requests.
    const total = await scorePendingReferencePhotos(100, 200);
    if (total.scored) log.info(total, "Scored reference photos");
  } catch (err) {
    log.warn({ err }, "Reference photo scoring failed");
  } finally {
    running = false;
  }
}

export function startReferencePhotoScoring(): void {
  void run();
  setInterval(() => void run(), HOUR_MS).unref();
}
