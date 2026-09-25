// Finds reference images (gallery photos and each species' main photo) that are maps or data
// graphics (range and distribution maps, charts, tables, spectrograms) rather than pictures of the
// animal. Wikipedia's media lists mix
// these in with the photos, and fetch-wikipedia-media.ts's filename filter misses the ones with
// unhelpful names (e.g. "Aix_galericulata_dis.PNG", a Mandarin Duck range map that shipped in
// its gallery).
//
// Content-based instead of filename-based: every reference image already has a CLIP vector, and
// CLIP's text encoder places "a range map" and "a photo of an animal" far apart. An image is
// flagged when it matches the best non-photo description better than the best photo description
// by more than --margin.
//
// Usage (the CLIP vision + text models must be downloaded under APP_DATA_DIR/models):
//   DATABASE_URL=... APP_DATA_DIR=... npx tsx apps/api/src/scripts/flag-non-photo-reference-images.ts \
//     [--margin=0.02] [--out=flagged.json] [--delete]
// Without --delete it only reports. --delete removes everything flagged above the margin;
// --apply=<file.json> removes exactly the entries in a list saved with --out (after reviewing it,
// which is the safer route: scores near the margin mix real photos in). Either way each removed
// image's URL goes into reference_photo_blocklist (migration 106), so catalog updates delete it
// from installs too. A gallery image is deleted with its files (vectors cascade). A MAIN photo is
// replaced by the species' first real gallery photo, or cleared if it has none, and that
// species' main-photo vectors are deleted so the backfill scripts recompute them.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pool } from "../db.js";
import { cosineSimilarity } from "../species/embeddings.js";
import { embedQueryText } from "../species/textEmbedding.js";
import { APP_DATA_DIR, EMBEDDING_MODEL_VERSION } from "../config.js";

// What gets removed: maps and data graphics, which show nothing about what the animal looks like.
const NON_PHOTO = [
  "a range map",
  "a distribution map of a species",
  "a map of the world with shaded regions",
  "a map of a country with a colored region",
  "a map",
  "a chart",
  "a graph",
  "a table of text",
  "a spectrogram",
  "a page of text",
];
// What counts as a keeper. Scientific drawings, museum plates and specimen photos (shells,
// skulls) are real identification references, especially for fish, sharks and shells, so they're
// scored as keepers rather than lumped in with maps.
const PHOTO = [
  "a photo of an animal",
  "a photo of a bird",
  "a wildlife photograph",
  "a photo of a plant",
  "a photo of an insect",
  "a photo of a fish",
  "a photo of a shell",
  "a photo of a skull",
  "a scientific drawing of an animal",
  "an illustration of an animal",
  "a black and white line drawing of a fish",
];

type Flagged = { kind: "gallery" | "main"; id: string; species: string; url: string | null; displayPath: string | null; score: number };
const REASON = "map or data graphic, not a photo of the animal";

async function removeFlagged(items: Flagged[]): Promise<void> {
  let gallery = 0;
  let promoted = 0;
  let cleared = 0;
  for (const f of items) {
    if (f.url) {
      await pool.query(
        `INSERT INTO reference_photo_blocklist (photo_url, reason) VALUES ($1, $2) ON CONFLICT (photo_url) DO NOTHING`,
        [f.url, REASON],
      );
    }
    if (f.kind === "gallery") {
      // By URL, not just the flagged row: the same image can sit in several species' galleries
      // (a genus comparison table attached to each species in it), and the blocklist is by URL.
      const res = await pool.query<{ display_path: string | null; thumb_path: string | null }>(
        `DELETE FROM species_reference_photos WHERE id = $1 OR ($2::text IS NOT NULL AND photo_url = $2) RETURNING display_path, thumb_path`,
        [f.id, f.url],
      );
      for (const r of res.rows) for (const p of [r.display_path, r.thumb_path]) if (p) rmSync(p, { force: true });
      gallery += res.rows.length;
      continue;
    }
    // Main photo: f.id is the species id.
    const sp = (
      await pool.query<{ reference_display_path: string | null; reference_thumb_path: string | null }>(
        `SELECT reference_display_path, reference_thumb_path FROM species WHERE id = $1`,
        [f.id],
      )
    ).rows[0];
    const next = (
      await pool.query<{ photo_url: string; credit: string; license: string; display_path: string | null; thumb_path: string | null }>(
        `SELECT p.photo_url, p.credit, p.license, p.display_path, p.thumb_path FROM species_reference_photos p
         WHERE p.species_id = $1 AND NOT EXISTS (SELECT 1 FROM reference_photo_blocklist b WHERE b.photo_url = p.photo_url)
         ORDER BY p.sort_order`,
        [f.id],
      )
    ).rows.find((p) => p.display_path && existsSync(p.display_path) && p.thumb_path && existsSync(p.thumb_path));
    const display = sp?.reference_display_path ?? path.join(APP_DATA_DIR, "reference-display", `${f.id}.webp`);
    const thumb = sp?.reference_thumb_path ?? path.join(APP_DATA_DIR, "reference-thumb", `${f.id}.webp`);
    if (next) {
      mkdirSync(path.dirname(display), { recursive: true });
      mkdirSync(path.dirname(thumb), { recursive: true });
      copyFileSync(next.display_path!, display);
      copyFileSync(next.thumb_path!, thumb);
      await pool.query(
        `UPDATE species SET reference_photo = $2, reference_credit = $3, reference_license = $4,
           reference_display_path = $5, reference_thumb_path = $6, reference_focal_x = NULL, reference_focal_y = NULL
         WHERE id = $1`,
        [f.id, next.photo_url, next.credit, next.license, display, thumb],
      );
      promoted++;
    } else {
      for (const p of [sp?.reference_display_path, sp?.reference_thumb_path]) if (p) rmSync(p, { force: true });
      await pool.query(
        `UPDATE species SET reference_photo = NULL, reference_credit = NULL, reference_license = NULL,
           reference_display_path = NULL, reference_thumb_path = NULL, reference_focal_x = NULL, reference_focal_y = NULL
         WHERE id = $1`,
        [f.id],
      );
      cleared++;
    }
    await pool.query(`DELETE FROM species_reference_embeddings WHERE species_id = $1`, [f.id]);
    await pool.query(`DELETE FROM id_model_reference_embeddings WHERE species_id = $1`, [f.id]);
  }
  console.log(`[flag-non-photo] removed ${gallery} gallery images; main photos: ${promoted} replaced from the gallery, ${cleared} cleared`);
}

async function main() {
  const applyFile = process.argv.find((a) => a.startsWith("--apply="))?.split("=")[1];
  if (applyFile) {
    await removeFlagged(JSON.parse(readFileSync(applyFile, "utf8")) as Flagged[]);
    await pool.end();
    return;
  }
  const margin = Number(process.argv.find((a) => a.startsWith("--margin="))?.split("=")[1] ?? 0.02);
  const out = process.argv.find((a) => a.startsWith("--out="))?.split("=")[1] ?? null;
  const doDelete = process.argv.includes("--delete");

  const nonPhoto = await Promise.all(NON_PHOTO.map(embedQueryText));
  const photo = await Promise.all(PHOTO.map(embedQueryText));
  const score = (v: number[]) => {
    const best = (list: number[][]) => Math.max(...list.map((t) => cosineSimilarity(v, t)));
    return best(nonPhoto) - best(photo);
  };

  const flagged: Flagged[] = [];
  let scanned = 0;
  let after = "00000000-0000-0000-0000-000000000000";
  while (true) {
    const page = await pool.query<{ id: string; species: string; url: string; display_path: string | null; embedding: number[] }>(
      `SELECT p.id, s.scientific_name AS species, p.photo_url AS url, p.display_path, ge.embedding
       FROM species_reference_gallery_embeddings ge
       JOIN species_reference_photos p ON p.id = ge.reference_photo_id
       JOIN species s ON s.id = p.species_id
       WHERE ge.model_version = $1 AND p.id > $2 ORDER BY p.id LIMIT 5000`,
      [EMBEDDING_MODEL_VERSION, after],
    );
    if (page.rows.length === 0) break;
    for (const r of page.rows) {
      const sc = score(r.embedding);
      if (sc > margin) flagged.push({ kind: "gallery", id: r.id, species: r.species, url: r.url, displayPath: r.display_path, score: sc });
    }
    scanned += page.rows.length;
    after = page.rows[page.rows.length - 1].id;
  }
  const mains = await pool.query<{ id: string; species: string; url: string | null; display_path: string | null; embedding: number[] }>(
    `SELECT s.id, s.scientific_name AS species, s.reference_photo AS url, s.reference_display_path AS display_path, e.embedding
     FROM species_reference_embeddings e JOIN species s ON s.id = e.species_id WHERE e.model_version = $1`,
    [EMBEDDING_MODEL_VERSION],
  );
  for (const r of mains.rows) {
    const sc = score(r.embedding);
    if (sc > margin) flagged.push({ kind: "main", id: r.id, species: r.species, url: r.url, displayPath: r.display_path, score: sc });
  }
  scanned += mains.rows.length;
  flagged.sort((a, b) => b.score - a.score);

  const count = (k: string) => flagged.filter((f) => f.kind === k).length;
  console.log(`[flag-non-photo] scanned ${scanned} images; flagged ${count("gallery")} gallery, ${count("main")} main (margin ${margin})`);
  for (const f of flagged.slice(0, 20)) console.log(`  ${f.score.toFixed(3)} ${f.kind} ${f.species}: ${f.url}`);
  if (out) writeFileSync(out, JSON.stringify(flagged, null, 2));

  if (doDelete) await removeFlagged(flagged);
  await pool.end();
  // The text model's native bindings crash on a normal teardown after heavy use; everything is
  // written by now.
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
