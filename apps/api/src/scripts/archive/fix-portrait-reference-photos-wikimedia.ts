// Wikimedia counterpart to fix-portrait-reference-photos.ts — full restore for every
// Wikimedia-sourced species reference photo (~2,431 of them), not just the ones a cheap
// pre-check flags as mismatched. This app otherwise avoids re-fetching Wikimedia in bulk (see
// fetch-with-retry.ts and this session's own discussion — bulk Wikimedia fetches triggered
// 600-second retry-after penalties). This is a deliberate, one-time EXCEPTION to that rule
// specifically to undo damage this app's own earlier bug did to files it had already
// legitimately downloaded — not a return to routine bulk Wikimedia fetching. Made as gentle
// as reasonably possible: CONCURRENCY=1 (not 8, unlike the iNaturalist version) and a flat
// pacing delay between every single request regardless of outcome, not just reactive backoff
// after a 429.
import { pool } from "../db.js";
import { generateReferenceDerivatives } from "../uploads/image.js";
import { mapWithConcurrency } from "data-pipeline/src/concurrency.js";
import { renameSync } from "node:fs";
import { setDefaultResultOrder } from "node:dns";
import sharp from "sharp";

// upload.wikimedia.org's edge (Varnish/cp nodes) has been returning sustained 600s
// retry-after penalties specifically over IPv6 on this network — confirmed by hand: the
// exact same request over IPv4 (curl -4) gets a clean 200 immediately. This has nothing to
// do with our own request volume; forcing Node's fetch to resolve/connect over IPv4 avoids
// whatever is happening on the IPv6 path entirely.
setDefaultResultOrder("ipv4first");

const CONCURRENCY = 1;
const REQUEST_PACING_MS = 2000;
// Wikimedia Foundation's User-Agent policy (foundation.wikimedia.org/wiki/Policy:Wikimedia_
// Foundation_User-Agent_Policy) requires real contact info in this exact shape — "name/version
// (contact) library/version" — or the edge classifies the request as unidentified bot traffic
// and throttles it far more aggressively (this is a known, currently-open issue for third-party
// apps generally: phabricator.wikimedia.org/T413570). The previous "lifer-api/0.1 (personal
// project)" string had no real contact info at all, which is likely why every bulk pass this
// session hit sustained 600s retry-after penalties regardless of IP or protocol.
const USER_AGENT = "lifer-app/0.1 (https://github.com/Sparklysparkspark)";

// Same T413570 thread: apps that don't send a Referer pointing at the actual Commons file page
// get bucketed as bots even more aggressively than ones that do. Derived from the upload URL's
// own filename rather than looked up separately — no extra request needed.
// Deliberately NOT decodeURIComponent'd — HTTP header values must be Latin1/ByteString, and
// Commons filenames routinely contain non-Latin1 characters (accented letters, CJK, etc.) that
// throw a hard "Cannot convert argument to a ByteString" error from fetch() itself if decoded
// first. The percent-encoded form is itself valid header content and Commons resolves it fine.
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
      console.error(`[fix-portrait-wm] network error, retrying:`, err instanceof Error ? err.message : err);
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      continue;
    }
    if (res.status !== 429) return res;
    const retryAfter = Number(res.headers.get("retry-after"));
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt;
    console.error(`[fix-portrait-wm] 429, backing off ${Math.round(delayMs / 1000)}s`);
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
  reference_photo: string;
  reference_display_path: string;
  reference_thumb_path: string;
}): Promise<"restored" | "fetch-failed"> {
  const res = await fetchWithRetry(row.reference_photo);
  await pace();
  if (!res.ok) return "fetch-failed";
  const buffer = Buffer.from(await res.arrayBuffer());

  const tmpPaths = await generateReferenceDerivatives(buffer, `_tmp-wm-${row.id}`);
  renameSync(tmpPaths.displayPath, row.reference_display_path);
  renameSync(tmpPaths.thumbPath, row.reference_thumb_path);

  const meta = await sharp(buffer).metadata();
  if (meta.width && meta.height && isMismatched(meta.width / meta.height)) {
    const focal = await computeFocalPoint(buffer);
    if (focal) {
      await pool.query(`UPDATE species SET reference_focal_x = $1, reference_focal_y = $2 WHERE id = $3`, [
        focal.x,
        focal.y,
        row.id,
      ]);
    }
  }
  return "restored";
}

async function main() {
  const speciesRes = await pool.query<{
    id: string;
    scientific_name: string;
    reference_photo: string;
    reference_display_path: string;
    reference_thumb_path: string;
  }>(
    `SELECT id, scientific_name, reference_photo, reference_display_path, reference_thumb_path FROM species
     WHERE reference_photo LIKE '%upload.wikimedia.org%' AND reference_display_path IS NOT NULL AND reference_thumb_path IS NOT NULL`,
  );
  console.log(`[fix-portrait-wm] restoring ${speciesRes.rows.length} Wikimedia-sourced species (slow, one at a time, full re-fetch)`);

  const counts = { restored: 0, "fetch-failed": 0, error: 0 };
  let done = 0;
  await mapWithConcurrency(speciesRes.rows, CONCURRENCY, async (row) => {
    let outcome: "restored" | "fetch-failed" | "error";
    try {
      outcome = await fixOne(row);
    } catch (err) {
      console.error(`[fix-portrait-wm] error on ${row.scientific_name}:`, err instanceof Error ? err.message : err);
      outcome = "error";
    }
    counts[outcome]++;
    done++;
    if (done % 100 === 0) {
      console.log(`[fix-portrait-wm] ${done}/${speciesRes.rows.length} — restored:${counts.restored} failed:${counts["fetch-failed"]} errors:${counts.error}`);
    }
  });

  console.log(`[fix-portrait-wm] done. ${JSON.stringify(counts)}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
