// Re-downloads reference photos (each species' main photo and its gallery photos) whose cached
// display or thumb file is missing on disk even though the database still points at it. Packs
// copy these files in (build-region-pack.ts skips a file that isn't there), so a missing file
// meant a published pack silently shipped without that species' photo. Found 5,000+ missing
// main photos in the maintainer database in September 2026, concentrated in British Columbia.
//
// Uses the same download + derivative code enrichment does (downloadAndCacheImage: per-host
// pacing, retry on 429), writing to the exact paths already recorded, so nothing in the database
// changes. Rows whose recorded path isn't where that code would write (a different APP_DATA_DIR)
// are skipped and reported rather than written somewhere unexpected.
//
// --adopt handles only the rows recorded OUTSIDE APP_DATA_DIR instead (in the same database,
// 261 pointed at a desktop app's own folder, so packs built from it depended on that app's files
// still existing): copies each file into APP_DATA_DIR (re-downloading any that are gone) and
// repoints the row there.
//
// Usage (APP_DATA_DIR must be the directory the recorded paths live under):
//   DATABASE_URL=postgres://lifer:lifer@localhost:5432/lifer APP_DATA_DIR=<repo>/data/lifer \
//     npx tsx apps/api/src/scripts/repair-missing-reference-photos.ts [--dry-run] [--adopt] [--countries=Canada,...]
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { mapWithConcurrency } from "data-pipeline/src/concurrency.js";
import { APP_DATA_DIR } from "../config.js";
import { pool } from "../db.js";
import { downloadAndCacheImage } from "../species/lazyEnrich.js";

const CONCURRENCY = 4;

interface Row {
  kind: "main" | "gallery";
  url: string | null;
  displayPath: string;
  thumbPath: string | null;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const countriesArg = process.argv.find((a) => a.startsWith("--countries="));
  const countries = countriesArg ? countriesArg.split("=")[1].split(",") : null;
  const scope = countries
    ? `AND s.id IN (SELECT rs.species_id FROM region_species rs JOIN regions r ON r.id = rs.region_id
                    WHERE r.name = ANY($1) AND r.parent_id IN (SELECT id FROM regions WHERE parent_id = (SELECT id FROM regions WHERE name = 'World' AND parent_id IS NULL)))`
    : "";
  const params = countries ? [countries] : [];

  const main = await pool.query<{ url: string | null; display_path: string; thumb_path: string | null }>(
    `SELECT s.reference_photo AS url, s.reference_display_path AS display_path, s.reference_thumb_path AS thumb_path
     FROM species s WHERE s.reference_display_path IS NOT NULL ${scope}`,
    params,
  );
  const gallery = await pool.query<{ url: string | null; display_path: string; thumb_path: string | null }>(
    `SELECT p.photo_url AS url, p.display_path, p.thumb_path
     FROM species_reference_photos p JOIN species s ON s.id = p.species_id
     WHERE p.display_path IS NOT NULL ${scope}`,
    params,
  );
  const rows: Row[] = [
    ...main.rows.map((r) => ({ kind: "main" as const, url: r.url, displayPath: r.display_path, thumbPath: r.thumb_path })),
    ...gallery.rows.map((r) => ({ kind: "gallery" as const, url: r.url, displayPath: r.display_path, thumbPath: r.thumb_path })),
  ];
  const missing = rows.filter((r) => !existsSync(r.displayPath) || (r.thumbPath != null && !existsSync(r.thumbPath)));

  const displayDir = path.join(APP_DATA_DIR, "reference-display");
  const thumbDir = path.join(APP_DATA_DIR, "reference-thumb");
  const keyOf = (r: Row) => path.basename(r.displayPath, ".webp");
  const writable = missing.filter(
    (r) =>
      r.url &&
      path.dirname(r.displayPath) === displayDir &&
      (r.thumbPath == null || r.thumbPath === path.join(thumbDir, `${keyOf(r)}.webp`)),
  );
  if (process.argv.includes("--adopt")) {
    await adopt(rows.filter((r) => path.dirname(r.displayPath) !== displayDir), displayDir, thumbDir, dryRun);
    await pool.end();
    return;
  }
  const noUrl = missing.filter((r) => !r.url).length;
  const elsewhere = missing.length - writable.length - noUrl;
  const count = (kind: Row["kind"]) => missing.filter((r) => r.kind === kind).length;
  console.log(
    `[repair-missing-reference-photos] ${missing.length} missing (${count("main")} main, ${count("gallery")} gallery); ` +
      `${writable.length} to re-download, ${noUrl} with no URL, ${elsewhere} recorded outside ${APP_DATA_DIR}`,
  );
  if (dryRun || writable.length === 0) {
    await pool.end();
    return;
  }

  let done = 0;
  let failed = 0;
  const failures: string[] = [];
  // One queue per host, run side by side: a host that starts rate-limiting (Wikimedia answers a
  // burst with 429s and a 10-minute Retry-After) otherwise ties up every worker in backoff while
  // photos from other hosts wait behind it. downloadAndCacheImage already paces each host.
  const byHost = new Map<string, Row[]>();
  for (const r of writable) {
    const host = new URL(r.url!).host;
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host)!.push(r);
  }
  await Promise.all(
    [...byHost.values()].map((hostRows) =>
      mapWithConcurrency(hostRows, CONCURRENCY, async (r) => {
        const out = await downloadAndCacheImage(r.url!, keyOf(r));
        if (!out || !existsSync(r.displayPath)) {
          failed++;
          failures.push(r.url!);
        }
        if (++done % 100 === 0) console.log(`[repair-missing-reference-photos] ${done}/${writable.length} (${failed} failed)`);
      }),
    ),
  );
  console.log(`[repair-missing-reference-photos] done: ${done - failed} restored, ${failed} failed`);
  for (const url of failures.slice(0, 50)) console.log(`  failed: ${url}`);
  await pool.end();
}

async function adopt(outside: Row[], displayDir: string, thumbDir: string, dryRun: boolean): Promise<void> {
  console.log(`[repair-missing-reference-photos] ${outside.length} rows recorded outside ${APP_DATA_DIR}`);
  if (dryRun) return;
  let moved = 0;
  let downloaded = 0;
  let failed = 0;
  for (const r of outside) {
    const key = path.basename(r.displayPath, ".webp");
    const display = path.join(displayDir, `${key}.webp`);
    const thumb = path.join(thumbDir, `${key}.webp`);
    const haveOld = existsSync(r.displayPath) && (r.thumbPath == null || existsSync(r.thumbPath));
    if (!existsSync(display)) {
      if (haveOld) {
        copyFileSync(r.displayPath, display);
        if (r.thumbPath) copyFileSync(r.thumbPath, thumb);
        moved++;
      } else if (r.url && (await downloadAndCacheImage(r.url, key))) {
        downloaded++;
      } else {
        failed++;
        console.log(`  failed: ${r.url ?? r.displayPath}`);
        continue;
      }
    }
    if (r.kind === "main") {
      await pool.query(`UPDATE species SET reference_display_path = $1, reference_thumb_path = $2 WHERE reference_display_path = $3`, [
        display,
        thumb,
        r.displayPath,
      ]);
    } else {
      await pool.query(`UPDATE species_reference_photos SET display_path = $1, thumb_path = $2 WHERE display_path = $3`, [
        display,
        thumb,
        r.displayPath,
      ]);
    }
  }
  console.log(`[repair-missing-reference-photos] adopted: ${moved} copied, ${downloaded} re-downloaded, ${failed} failed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
