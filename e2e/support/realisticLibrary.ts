// The realistic fixture's own photos and marks: two trips of camera JPEGs (varied aspect ratios),
// card crops, hidden photos, seen and target marks, a species hidden from a checklist and an
// album. All of it is decided by a seeded PRNG; the JPEGs are made once and cached.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { REAL_SPECIES, realCountry } from "./realisticCatalog.js";
import { CACHE_DIR, speciesPixels } from "./realisticPacks.js";

export interface PlannedPhoto {
  file: string;
  speciesIndex: number;
  taken: string;
  width: number;
  height: number;
}

export interface PlannedTrip {
  name: string;
  /** The region the import files the photos under. */
  region: string;
  photos: PlannedPhoto[];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ASPECTS: Array<[number, number]> = [
  [3, 2],
  [2, 3],
  [4, 3],
  [16, 9],
  [1, 1],
  [4, 5],
];

const rng = mulberry32(23);
const sample = (pool: number[], n: number) => {
  const copy = [...pool];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
};
const withPhoto = (i: number) => REAL_SPECIES[i].hasPhoto;

function planTrip(name: string, region: string, pool: number[], speciesCount: number, month: string): PlannedTrip {
  const photos: PlannedPhoto[] = [];
  sample(pool, speciesCount).forEach((speciesIndex, n) => {
    const shots = 1 + Math.floor(rng() * 3);
    for (let k = 0; k < shots; k++) {
      const [aw, ah] = ASPECTS[Math.floor(rng() * ASPECTS.length)];
      const long = 1024;
      const width = aw >= ah ? long : Math.round((long * aw) / ah);
      const height = aw >= ah ? Math.round((long * ah) / aw) : long;
      const day = String(1 + (n % 27)).padStart(2, "0");
      const minute = String((n * 3 + k) % 60).padStart(2, "0");
      photos.push({
        file: `IMG_${String(photos.length + 1).padStart(4, "0")}.jpg`,
        speciesIndex,
        // Midday, so the date reads the same in every time zone.
        taken: `2024:${month}:${day} 12:${minute}:00`,
        width,
        height,
      });
    }
  });
  return { name, region, photos };
}

const costaRica = realCountry("Costa Rica");
const bc = realCountry("Canada").provinces.find((p) => p.name === "British Columbia")!;
export const TRIPS: PlannedTrip[] = [
  planTrip("Costa Rica, March 2024", "Costa Rica", costaRica.members, 190, "03"),
  planTrip("British Columbia, June 2024", "British Columbia", bc.members, 80, "06"),
];
const photographed = [...new Set(TRIPS.flatMap((t) => t.photos.map((p) => p.speciesIndex)))];
const notPhotographed = costaRica.members.filter((i) => !photographed.includes(i) && withPhoto(i));

/** Species marks and edits made through the API after the imports. */
export const MARKS = {
  seen: sample(notPhotographed, 40),
  target: sample(notPhotographed, 30),
  cardCrops: sample(photographed, 15),
  /** Hidden from Costa Rica's checklist. */
  hiddenInCostaRica: sample(notPhotographed, 6),
  /** Photos hidden in the library: file names in the first trip. */
  hiddenPhotos: sample(
    TRIPS[0].photos.map((_, i) => i),
    12,
  ).map((i) => TRIPS[0].photos[i].file),
  albumPhotos: sample(
    TRIPS[0].photos.map((_, i) => i),
    24,
  ).map((i) => TRIPS[0].photos[i].file),
};
export const ALBUM_NAME = "Best of Costa Rica";

/** Copies the trip's JPEGs into `folder`, making any not cached yet. */
export async function writeTripPhotos(trip: PlannedTrip, folder: string): Promise<void> {
  const cache = path.join(CACHE_DIR, "trips", trip.name.replace(/[^a-z0-9]+/gi, "-"));
  mkdirSync(cache, { recursive: true });
  const have = new Set(readdirSync(cache));
  for (let start = 0; start < trip.photos.length; start += 16) {
    await Promise.all(
      trip.photos.slice(start, start + 16).map(async (p, k) => {
        if (have.has(p.file)) return;
        // Its species' bars with a shift of hue per photo, so no two photos share content.
        const pixels = speciesPixels(p.speciesIndex, p.width, p.height, 40 + ((start + k) % 7) * 20);
        await sharp(pixels, { raw: { width: p.width, height: p.height, channels: 3 } })
          .withExif({ IFD0: { Make: "Lifer", Model: "E2E Test Camera" }, IFD2: { DateTimeOriginal: p.taken } })
          .jpeg({ quality: 80 })
          .toFile(path.join(cache, p.file));
      }),
    );
  }
  mkdirSync(folder, { recursive: true });
  for (const p of trip.photos) {
    if (!existsSync(path.join(folder, p.file))) copyFileSync(path.join(cache, p.file), path.join(folder, p.file));
  }
}
