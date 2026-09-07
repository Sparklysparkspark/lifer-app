// Wikimedia counterpart to fix-portrait-gallery-photos.ts — full restore for every
// Wikimedia-sourced gallery photo (~3,185 of them), same deliberate one-time exception to the
// "no bulk Wikimedia" rule as fix-portrait-reference-photos-wikimedia.ts (see that file's own
// comment for the reasoning and the pacing/concurrency choices).
import { pool } from "../db.js";
import { generateReferenceDerivatives } from "../uploads/image.js";
import { mapWithConcurrency } from "data-pipeline/src/concurrency.js";
import { renameSync } from "node:fs";
import { setDefaultResultOrder } from "node:dns";
import sharp from "sharp";

setDefaultResultOrder("ipv4first");

const CONCURRENCY = 1;
const REQUEST_PACING_MS = 2000;
// See fix-portrait-reference-photos-wikimedia.ts's own comment — same WMF User-Agent policy
// compliance fix (real contact info required or the edge classifies this as unidentified bot
// traffic and throttles far more aggressively; phabricator.wikimedia.org/T413570).
const USER_AGENT = "lifer-app/0.1 (https://github.com/Sparklysparkspark)";

// See fix-portrait-reference-photos-wikimedia.ts's own comment — deliberately not decoded,
// header values must be Latin1/ByteString and Commons filenames routinely aren't.
function refererFor(mediaUrl: string): string {
  const filename = new URL(mediaUrl).pathname.split("/").pop() ?? "";
  return `https://commons.wikimedia.org/wiki/File:${filename}`;
}

const HERO_ASPECT = 16 / 9;
const THUMB_ASPECT = 1;
const MISMATCH_LOG_RATIO_THRESHOLD = 0.35;

function isMismatched(sourceAspect: number): boolean {
  const heroDelta = Math.abs(Math.log(sourceAspect / HERO_ASPECT));
  const thumbDelta = Math.abs(Math.log(sourceAspect / THUMB_ASPECT));
  return heroDelta > MISMATCH_LOG_RATIO_THRESHOLD && thumbDelta > MISMATCH_LOG_RATIO_THRESHOLD;
}

async function pace(): Promise<void> {
  await new Promise((r) => setTimeout(r, REQUEST_PACING_MS));
}

async function fetchWithRetry(url: string): Promise<Response> {
  const headers = { "User-Agent": USER_AGENT, Referer: refererFor(url) };
  for (let attempt = 0; attempt <= 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers });
    } catch (err) {
      console.error(`[fix-gallery-wm] network error, retrying:`, err instanceof Error ? err.message : err);
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      continue;
    }
    if (res.status !== 429) return res;
    const retryAfter = Number(res.headers.get("retry-after"));
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt;
    console.error(`[fix-gallery-wm] 429, backing off ${Math.round(delayMs / 1000)}s`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return fetch(url, { headers });
}

async function computeFocalPoint(buffer: Buffer): Promise<{ x: number; y: number } | null> {
  const DOWNSAMPLE_WIDTH = 64;
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) return null;
  const dsHeight = Math.max(2, Math.round((DOWNSAMPLE_WIDTH * meta.height) / meta.width));
  const { data, info } = await sharp(buffer)
    .rotate()
    .greyscale()
    .resize({ width: DOWNSAMPLE_WIDTH, height: dsHeight, fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  let sumWeight = 0;
  let sumX = 0;
  let sumY = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx = data[y * w + x + 1] - data[y * w + x - 1];
      const gy = data[(y + 1) * w + x] - data[(y - 1) * w + x];
      const magnitude = Math.sqrt(gx * gx + gy * gy);
      const weight = magnitude * magnitude;
      sumWeight += weight;
      sumX += weight * x;
      sumY += weight * y;
    }
  }
  if (sumWeight === 0) return null;
  return { x: (sumX / sumWeight / (w - 1)) * 100, y: (sumY / sumWeight / (h - 1)) * 100 };
}

async function fixOne(row: {
  id: string;
  photo_url: string;
  display_path: string;
  thumb_path: string;
}): Promise<"restored" | "fetch-failed"> {
  const res = await fetchWithRetry(row.photo_url);
  await pace();
  if (!res.ok) return "fetch-failed";
  const buffer = Buffer.from(await res.arrayBuffer());

  const tmpPaths = await generateReferenceDerivatives(buffer, `_tmp-gallery-wm-${row.id}`);
  renameSync(tmpPaths.displayPath, row.display_path);
  renameSync(tmpPaths.thumbPath, row.thumb_path);

  const meta = await sharp(buffer).metadata();
  if (meta.width && meta.height && isMismatched(meta.width / meta.height)) {
    const focal = await computeFocalPoint(buffer);
    if (focal) {
      await pool.query(
        `UPDATE species_reference_photos SET focal_x = $1, focal_y = $2 WHERE id = $3`,
        [focal.x, focal.y, row.id],
      );
    }
  }
  return "restored";
}

async function main() {
  const res = await pool.query<{ id: string; photo_url: string; display_path: string; thumb_path: string }>(
    `SELECT id, photo_url, display_path, thumb_path FROM species_reference_photos
     WHERE photo_url LIKE '%upload.wikimedia.org%' AND display_path IS NOT NULL AND thumb_path IS NOT NULL`,
  );
  console.log(`[fix-gallery-wm] restoring ${res.rows.length} Wikimedia-sourced gallery photos (slow, one at a time, full re-fetch)`);

  const counts = { restored: 0, "fetch-failed": 0, error: 0 };
  let done = 0;
  await mapWithConcurrency(res.rows, CONCURRENCY, async (row) => {
    let outcome: "restored" | "fetch-failed" | "error";
    try {
      outcome = await fixOne(row);
    } catch (err) {
      console.error(`[fix-gallery-wm] error on gallery photo ${row.id}:`, err instanceof Error ? err.message : err);
      outcome = "error";
    }
    counts[outcome]++;
    done++;
    if (done % 100 === 0) {
      console.log(`[fix-gallery-wm] ${done}/${res.rows.length} — restored:${counts.restored} failed:${counts["fetch-failed"]} errors:${counts.error}`);
    }
  });

  console.log(`[fix-gallery-wm] done. ${JSON.stringify(counts)}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
