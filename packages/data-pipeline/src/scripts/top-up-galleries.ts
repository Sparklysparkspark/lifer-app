// Tops up thin reference galleries from iNaturalist: a species with fewer than --min-photos
// publishable gallery photos gets the first photo of its most-voted research-grade observations,
// publishable licences only, up to --target. Photos that aren't of the animal (eggs, tracks,
// habitat; referencePortrait.ts) are left out. Stores them through persistReference.ts, which
// computes their matching vectors.
//
//   npm run top-up-galleries -w data-pipeline                                 every thin species
//   npm run top-up-galleries -w data-pipeline -- --class=squamata,amphibia    some taxon classes
//   npm run top-up-galleries -w data-pipeline -- --region=BLZ --per-class=100 a capped regional run
//   npm run top-up-galleries -w data-pipeline -- --species-file=<ids.txt>     only these species
//
// Rerun the same command to resume: only species still under --min-photos are read again, and
// iNaturalist's answers come from inat_response_cache. --per-class and --limit cap each run, so a
// capped rerun moves on to the next thin species. Prints a per-class summary as JSON.
import { readFile, rm, statfs } from "node:fs/promises";
import { parseArgs } from "node:util";
import { APP_DATA_DIR } from "@lifer/core/config.js";
import { withTransaction } from "@lifer/core/db.js";
import { MAX_GALLERY_PHOTOS } from "@lifer/core/species/enrich.js";
import { computeEmbedding } from "@lifer/core/species/embeddings.js";
import { idModel } from "@lifer/core/species/idModel.js";
import {
  downloadAndCacheImage,
  fetchObservationPhotos,
  PersistentRateLimitError,
  setInatResponseCacheMaxAge,
} from "@lifer/core/species/inatClient.js";
import { INAT_PUBLISHABLE_LICENSE_CODES } from "@lifer/core/species/licensePolicy.js";
import { persistGalleryPromotingMainIfMissing } from "@lifer/core/species/persistReference.js";
import { classifyReferencePhoto, PORTRAIT } from "@lifer/core/species/referencePortrait.js";
import { pool } from "../db.js";
import { closeClip, prepareClip } from "../lib/clipEmbedding.js";
import { photoKey, publishableCount, topUpCandidates } from "@lifer/core/species/galleryTopUp.js";

setInatResponseCacheMaxAge(null);

const { values: args } = parseArgs({
  options: {
    class: { type: "string", default: "all" },
    region: { type: "string" },
    "min-photos": { type: "string", default: "5" },
    target: { type: "string", default: String(MAX_GALLERY_PHOTOS) },
    "per-class": { type: "string" },
    limit: { type: "string" },
    // A file of species ids, one per line: only these (the marine widening's new species).
    "species-file": { type: "string" },
    // Stops cleanly (exit code 3) before a species when the reference image disk has less free.
    "min-free-gb": { type: "string", default: "0" },
  },
});
const MIN = Number(args["min-photos"]);
const TARGET = Number(args.target);
// Twice the target leaves room for photos already in the gallery and ones that aren't portraits.
const FETCH = TARGET * 2;
const classes = args.class === "all" ? null : args.class!.split(",");
const MIN_FREE_BYTES = Number(args["min-free-gb"]) * 1024 ** 3;
const only = args["species-file"]
  ? (await readFile(args["species-file"], "utf8")).split("\n").filter((l) => l.trim())
  : null;
// This many unanswered species in a row means iNaturalist is down or refusing us: stop and let the
// caller back off, rather than skip through every remaining species.
const MAX_UNANSWERED_IN_A_ROW = 25;

interface Row {
  id: string;
  taxon_class: string;
  inat_taxon_id: number;
  reference_photo: string | null;
  gallery: Array<{ url: string; license: string | null }>;
  max_sort: number;
}

interface ClassTally {
  candidates: number;
  thin: number;
  run: number;
  toppedUp: number;
  reachedMin: number;
  noOpenPhotos: number;
  unanswered: number;
  photosAdded: number;
  downloadFailed: number;
  nonPortrait: Record<string, number>;
  licenses: Record<string, number>;
}

async function thinSpecies(): Promise<{ rows: Row[]; tally: Map<string, ClassTally> }> {
  const res = await pool.query<Row>(
    `SELECT s.id, s.taxon_class, s.inat_taxon_id, s.reference_photo,
            COALESCE(json_agg(json_build_object('url', p.photo_url, 'license', p.license))
                     FILTER (WHERE p.id IS NOT NULL), '[]') AS gallery,
            COALESCE(max(p.sort_order), -1) AS max_sort
       FROM species s
       LEFT JOIN species_reference_photos p ON p.species_id = s.id
      WHERE NOT s.is_other_taxa AND s.inat_taxon_id IS NOT NULL
        AND ($1::text[] IS NULL OR s.taxon_class = ANY($1))
        AND ($2::text IS NULL OR s.id IN (
              SELECT rs.species_id FROM region_species rs
               -- A district without a GADM id keeps its GBIF outline in external_codes, so its ISO code is the eBird one.
               WHERE rs.region_id IN (SELECT id FROM regions WHERE $2 = ANY(external_codes) OR ebird_region_code = $2)))
        AND ($3::uuid[] IS NULL OR s.id = ANY($3))
      GROUP BY s.id`,
    [classes, args.region ?? null, only],
  );
  const tally = new Map<string, ClassTally>();
  const byClass = new Map<string, Array<Row & { n: number }>>();
  for (const r of res.rows) {
    const t = tallyFor(tally, r.taxon_class);
    t.candidates++;
    const n = publishableCount(r.gallery);
    if (n >= MIN) continue;
    t.thin++;
    byClass.set(r.taxon_class, [...(byClass.get(r.taxon_class) ?? []), { ...r, n }]);
  }
  // Thinnest first, so a capped run spends its requests where they help most.
  const perClass = args["per-class"] ? Number(args["per-class"]) : Infinity;
  const rows = [...byClass.keys()].sort().flatMap((c) =>
    byClass
      .get(c)!
      .sort((a, b) => a.n - b.n || a.id.localeCompare(b.id))
      .slice(0, perClass),
  );
  return { rows: args.limit ? rows.slice(0, Number(args.limit)) : rows, tally };
}

function tallyFor(tally: Map<string, ClassTally>, cls: string): ClassTally {
  if (!tally.has(cls))
    tally.set(cls, {
      candidates: 0,
      thin: 0,
      run: 0,
      toppedUp: 0,
      reachedMin: 0,
      noOpenPhotos: 0,
      unanswered: 0,
      photosAdded: 0,
      downloadFailed: 0,
      nonPortrait: {},
      licenses: {},
    });
  return tally.get(cls)!;
}

async function topUp(r: Row, t: ClassTally): Promise<void> {
  const photos = await fetchObservationPhotos(r.inat_taxon_id, INAT_PUBLISHABLE_LICENSE_CODES, FETCH);
  // An error answer is no answer: the species stays thin and the next run asks again.
  if (photos === null) {
    t.unanswered++;
    return;
  }
  const have = publishableCount(r.gallery);
  const candidates = topUpCandidates(photos, [r.reference_photo, ...r.gallery.map((g) => g.url)]);
  if (candidates.length === 0) t.noOpenPhotos++;
  const added: Parameters<typeof persistGalleryPromotingMainIfMissing>[1] = [];
  for (const c of candidates) {
    if (have + added.length >= TARGET) break;
    const cached = await downloadAndCacheImage(c.photoUrl, `${r.id}-gallery-inat-${photoKey(c.photoUrl)}`);
    if (!cached) {
      t.downloadFailed++;
      continue;
    }
    // shortcut: CLIP runs again when the vectors are stored; pass the vector through if full runs get slow.
    const { kind } = classifyReferencePhoto(await computeEmbedding(await readFile(cached.displayPath)));
    if (kind !== PORTRAIT) {
      t.nonPortrait[kind] = (t.nonPortrait[kind] ?? 0) + 1;
      await Promise.all([rm(cached.displayPath, { force: true }), rm(cached.thumbPath, { force: true })]);
      continue;
    }
    added.push({ ...c, sortOrder: r.max_sort + 1 + added.length, ...cached });
    t.licenses[c.license] = (t.licenses[c.license] ?? 0) + 1;
  }
  if (added.length === 0) return;
  // Under the catalog lock, so a concurrent catalog clean-up never sees half a gallery.
  await withTransaction(() => persistGalleryPromotingMainIfMissing(r.id, added, r.reference_photo !== null), {
    lockReferenceData: true,
  });
  t.toppedUp++;
  t.photosAdded += added.length;
  // A promoted main photo leaves the gallery, so it doesn't count toward the gallery's total.
  if (have + added.length - (r.reference_photo === null ? 1 : 0) >= MIN) t.reachedMin++;
}

async function main() {
  // Without the identification model the photos would be stored with nothing to match against.
  if (!idModel.isDownloaded()) throw new Error("The identification model isn't downloaded");
  await prepareClip();
  const { rows, tally } = await thinSpecies();
  console.log(`${rows.length} thin species to top up (under ${MIN} publishable gallery photos, target ${TARGET})`);
  let done = 0;
  let unansweredInARow = 0;
  for (const r of rows) {
    const { bavail, bsize } = await statfs(APP_DATA_DIR);
    if (bavail * bsize < MIN_FREE_BYTES) {
      console.error(`\nStopping: under ${args["min-free-gb"]} GB free for reference images`);
      process.exitCode = 3;
      break;
    }
    const t = tallyFor(tally, r.taxon_class);
    t.run++;
    const unansweredBefore = t.unanswered;
    try {
      await topUp(r, t);
    } catch (err) {
      // Still throttled after every retry: stop, so iNaturalist gets a rest; rerun later to resume.
      if (err instanceof PersistentRateLimitError) throw err;
      t.unanswered++;
      console.warn(`\n  ${r.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    unansweredInARow = t.unanswered > unansweredBefore ? unansweredInARow + 1 : 0;
    if (unansweredInARow >= MAX_UNANSWERED_IN_A_ROW)
      throw new Error(`iNaturalist didn't answer ${MAX_UNANSWERED_IN_A_ROW} species in a row`);
    if (++done % 10 === 0) process.stdout.write(`\r  ${done}/${rows.length} species`);
  }
  console.log();
  console.log(JSON.stringify(Object.fromEntries([...tally].sort()), null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeClip();
    await pool.end();
  });
