// The widgets behind GET /stats, one loader each. They share one pooled client, so a page load
// doesn't take a pool slot per query.
import type { PoolClient } from "pg";
import { isGhostSpecies, isLostSpecies, type CollectionRow } from "../collection/collectionItem.js";
import { parseShutterSeconds, shutterSecondsSql } from "./shutter.js";

type Db = Pick<PoolClient, "query">;

// "Keeper": a capture with an edited JPEG (not a RAW still in the backlog) that isn't rated 1
// star, which marks an ID shot. Stats describe finished, kept photos.
export const KEEPER_FILTER = `EXISTS (SELECT 1 FROM originals o WHERE o.capture_id = c.id AND o.kind = 'jpeg') AND (c.quality_rating IS NULL OR c.quality_rating > 1)`;

export type PhotoFilter = "all" | "featured" | "topRated";

// "featured" is a species' cover photo, "topRated" a 5-star rating. The discovery timeline and
// new-lifers widgets are about species, so they ignore this filter.
export function photoFilterFragment(filter: PhotoFilter): string {
  if (filter === "featured") {
    return `AND c.current_photo_id = (SELECT us.cover_photo_id FROM user_species us WHERE us.user_id = c.user_id AND us.species_id = c.species_id)`;
  }
  if (filter === "topRated") {
    return `AND c.quality_rating = 5`;
  }
  return "";
}

// Promise.all that waits for every query before rejecting, so none is still running on the shared
// client when the caller releases it.
async function allSettledOrThrow<T extends readonly unknown[] | []>(
  pending: T,
): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
  await Promise.allSettled(pending);
  return Promise.all(pending);
}

function shutterLabel(seconds: number): string {
  return seconds >= 1 ? `${seconds}s` : `1/${Math.round(1 / seconds)}`;
}

export function fullHourLabel(hour: number): string {
  if (hour === 0) return "12 AM";
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return "12 PM";
  return `${hour - 12} PM`;
}

// Each list is contiguous (one bucket's max is the next one's min) and open-ended at the top, so
// the database can bucket by the mins alone (width_bucket).
interface Bucket {
  label: string;
  min: number;
}

const FOCAL_LENGTH_BUCKETS: Bucket[] = [
  { label: "0-100mm", min: 0 },
  { label: "100-200mm", min: 100 },
  { label: "200-300mm", min: 200 },
  { label: "300-400mm", min: 300 },
  { label: "400-500mm", min: 400 },
  { label: "500-600mm", min: 500 },
  { label: "600-800mm", min: 600 },
  { label: "800mm+", min: 800 },
];
const ISO_BUCKETS: Bucket[] = [
  { label: "≤200", min: 0 },
  { label: "400", min: 201 },
  { label: "800", min: 401 },
  { label: "1600", min: 801 },
  { label: "3200", min: 1601 },
  { label: "6400+", min: 3201 },
];
const APERTURE_BUCKETS: Bucket[] = [
  { label: "f/1.0-2.0", min: 1 },
  { label: "f/2.0-2.8", min: 2 },
  { label: "f/2.8-4.0", min: 2.8 },
  { label: "f/4.0-5.6", min: 4 },
  { label: "f/5.6-8.0", min: 5.6 },
  { label: "f/8.0+", min: 8 },
];
// Fastest first, with the fastest electronic-shutter speeds split out rather than lumped together.
const SHUTTER_BUCKETS: Bucket[] = [
  { label: "≥1/16000", min: 0 },
  { label: "1/8000-1/16000", min: 1 / 16000 },
  { label: "1/4000-1/8000", min: 1 / 8000 },
  { label: "1/2000-1/4000", min: 1 / 4000 },
  { label: "1/1000-1/2000", min: 1 / 2000 },
  { label: "1/500-1/1000", min: 1 / 1000 },
  { label: "1/250-1/500", min: 1 / 500 },
  { label: "1/125-1/250", min: 1 / 250 },
  { label: "≤1/125", min: 1 / 125 },
];

// Up to this many photo ids per bucket, so a chart bar can open a sample of its photos.
const MAX_PHOTO_IDS_PER_BUCKET = 300;

const EXIF_DIMENSIONS = {
  focalLength: FOCAL_LENGTH_BUCKETS,
  iso: ISO_BUCKETS,
  aperture: APERTURE_BUCKETS,
  shutter: SHUTTER_BUCKETS,
} as const;
type ExifDimension = keyof typeof EXIF_DIMENSIONS;

export interface ExifBucketRow {
  dim: ExifDimension;
  /** width_bucket's index: 0 below the first bucket, otherwise 1-based. */
  bucket: number;
  count: number;
  species: number;
  photo_ids: string[] | null;
}

export interface ExifBucket {
  label: string;
  count: number;
  photoIds: string[];
  species: number;
}

/** Lays the database's bucket rows for one dimension over its full bucket list, zeros included.
 *  `total` counts every value, including any below the first bucket. */
export function bucketsFor(rows: ExifBucketRow[], dim: ExifDimension): { buckets: ExifBucket[]; total: number } {
  const own = rows.filter((r) => r.dim === dim);
  const buckets = EXIF_DIMENSIONS[dim].map((b, i) => {
    const row = own.find((r) => r.bucket === i + 1);
    return { label: b.label, count: row?.count ?? 0, photoIds: row?.photo_ids ?? [], species: row?.species ?? 0 };
  });
  return { buckets, total: own.reduce((sum, r) => sum + r.count, 0) };
}

async function loadExifBuckets(db: Db, userId: string, scope: string): Promise<ExifBucketRow[]> {
  const mins = (buckets: Bucket[]) => buckets.map((b) => b.min);
  const res = await db.query<ExifBucketRow>(
    `SELECT d.dim, width_bucket(d.v, CASE d.dim WHEN 'focalLength' THEN $2::float8[] WHEN 'iso' THEN $3::float8[]
                                                WHEN 'aperture' THEN $4::float8[] ELSE $5::float8[] END) AS bucket,
            COUNT(*)::int AS count, COUNT(DISTINCT c.species_id)::int AS species,
            (array_agg(c.current_photo_id) FILTER (WHERE c.current_photo_id IS NOT NULL))[1:${MAX_PHOTO_IDS_PER_BUCKET}] AS photo_ids
     FROM captures c
     CROSS JOIN LATERAL (VALUES ('focalLength', c.focal_length_mm::float8), ('iso', c.iso::float8),
                                ('aperture', c.aperture::float8), ('shutter', ${shutterSecondsSql("c.shutter")})) AS d(dim, v)
     WHERE c.user_id = $1 AND ${scope} AND d.v IS NOT NULL
     GROUP BY d.dim, bucket`,
    [userId, mins(FOCAL_LENGTH_BUCKETS), mins(ISO_BUCKETS), mins(APERTURE_BUCKETS), mins(SHUTTER_BUCKETS)],
  );
  return res.rows;
}

async function loadPerMonth(db: Db, userId: string) {
  const [timelineRes, keepersPerMonthRes] = await allSettledOrThrow([
    db.query<{ date: string; count: number }>(
      `SELECT us.first_collected::text AS date, COUNT(*)::int AS count
       FROM user_species us WHERE us.user_id = $1 AND us.state = 'collected' AND us.first_collected IS NOT NULL
       GROUP BY us.first_collected ORDER BY us.first_collected`,
      [userId],
    ),
    // Keepers per month by taken_at (a keeper needn't be a lifer). Unfiltered by the photo filter,
    // like newLifersPerMonth, so the timeline's meaning doesn't change with the dropdown.
    db.query<{ month: string; count: number }>(
      `SELECT to_char(c.taken_at, 'YYYY-MM') AS month, COUNT(*)::int AS count
       FROM captures c WHERE c.user_id = $1 AND c.taken_at IS NOT NULL AND ${KEEPER_FILTER}
       GROUP BY month ORDER BY month`,
      [userId],
    ),
  ]);

  // One per-month series for both axes of the new lifers / keepers chart; the client picks which.
  const monthCounts = new Map<string, { newLifers: number; keepers: number }>();
  for (const r of timelineRes.rows) {
    const month = r.date.slice(0, 7);
    const entry = monthCounts.get(month) ?? { newLifers: 0, keepers: 0 };
    entry.newLifers += r.count;
    monthCounts.set(month, entry);
  }
  for (const r of keepersPerMonthRes.rows) {
    const entry = monthCounts.get(r.month) ?? { newLifers: 0, keepers: 0 };
    entry.keepers += r.count;
    monthCounts.set(r.month, entry);
  }
  return [...monthCounts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, counts]) => {
      const [year, m] = month.split("-");
      const label = new Date(Number(year), Number(m) - 1, 1).toLocaleString("en-US", {
        month: "short",
        year: "2-digit",
      });
      return { month, label, newLifers: counts.newLifers, keepers: counts.keepers };
    });
}

async function loadGearUsage(db: Db, userId: string, scope: string) {
  const [cameraRes, lensRes, comboRes] = await allSettledOrThrow([
    db.query<{ camera_model: string; photo_count: number; species_count: number }>(
      `SELECT c.camera_model, COUNT(*)::int AS photo_count, COUNT(DISTINCT c.species_id)::int AS species_count
       FROM captures c WHERE c.user_id = $1 AND c.camera_model IS NOT NULL AND ${scope}
       GROUP BY c.camera_model ORDER BY photo_count DESC`,
      [userId],
    ),
    db.query<{ lens: string; photo_count: number; species_count: number }>(
      `SELECT c.lens, COUNT(*)::int AS photo_count, COUNT(DISTINCT c.species_id)::int AS species_count
       FROM captures c WHERE c.user_id = $1 AND c.lens IS NOT NULL AND ${scope}
       GROUP BY c.lens ORDER BY photo_count DESC`,
      [userId],
    ),
    db.query<{ camera_model: string; lens: string; photo_count: number; species_count: number }>(
      `SELECT c.camera_model, c.lens, COUNT(*)::int AS photo_count, COUNT(DISTINCT c.species_id)::int AS species_count
       FROM captures c WHERE c.user_id = $1 AND c.camera_model IS NOT NULL AND c.lens IS NOT NULL AND ${scope}
       GROUP BY c.camera_model, c.lens ORDER BY photo_count DESC LIMIT 10`,
      [userId],
    ),
  ]);
  return {
    cameras: cameraRes.rows.map((r) => ({
      model: r.camera_model,
      photoCount: r.photo_count,
      speciesCount: r.species_count,
    })),
    lenses: lensRes.rows.map((r) => ({ model: r.lens, photoCount: r.photo_count, speciesCount: r.species_count })),
    combos: comboRes.rows.map((r) => ({
      camera: r.camera_model,
      lens: r.lens,
      photoCount: r.photo_count,
      speciesCount: r.species_count,
    })),
  };
}

async function loadTimeOfDay(db: Db, userId: string, scope: string) {
  const res = await db.query<{ hour: number; count: number }>(
    `SELECT EXTRACT(HOUR FROM c.taken_at)::int AS hour, COUNT(*)::int AS count
     FROM captures c WHERE c.user_id = $1 AND c.taken_at IS NOT NULL AND ${scope}
     GROUP BY hour ORDER BY hour`,
    [userId],
  );
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    label: fullHourLabel(hour),
    count: res.rows.find((r) => r.hour === hour)?.count ?? 0,
  }));
}

// Dots at the same spot merge on the chart, so this only bounds the payload; the date filter needs
// older years here too.
const SCATTER_LIMIT = 10_000;

async function loadScatter(db: Db, userId: string, scope: string) {
  const res = await db.query<{
    focal_length_mm: string | null;
    aperture: string | null;
    shutter: string | null;
    iso: number | null;
    scientific_name: string;
    common_name: string | null;
    photo_id: string | null;
    camera_model: string | null;
    lens: string | null;
    taken_at: Date | null;
  }>(
    // photo_id, not a path: thumbnails are served through GET /photos/:id/thumb.
    `SELECT c.focal_length_mm, c.aperture, c.shutter, c.iso, s.scientific_name, s.common_name, p.id AS photo_id,
            c.camera_model, c.lens, c.taken_at
     FROM captures c
     JOIN species s ON s.id = c.species_id
     LEFT JOIN photos p ON p.id = c.current_photo_id
     WHERE c.user_id = $1 AND ${scope}
     ORDER BY c.taken_at DESC NULLS LAST LIMIT ${SCATTER_LIMIT}`,
    [userId],
  );
  // Every scatter-plot axis; nulls are filtered client-side.
  return res.rows.map((r) => {
    const shutterSeconds = r.shutter != null ? parseShutterSeconds(r.shutter) : null;
    return {
      focalLength: r.focal_length_mm != null ? Number(r.focal_length_mm) : null,
      aperture: r.aperture != null ? Number(r.aperture) : null,
      iso: r.iso,
      shutterSeconds,
      shutterLabel: shutterSeconds != null ? shutterLabel(shutterSeconds) : null,
      scientificName: r.scientific_name,
      commonName: r.common_name,
      photoId: r.photo_id,
      // For the chart's body, lens and date filters.
      camera: r.camera_model,
      lens: r.lens,
      takenAt: r.taken_at,
    };
  });
}

async function loadCountries(db: Db, userId: string, scope: string) {
  // A capture's region is a country, one of its regional groups, or a province directly under
  // either (or shown under its continent, home_country_id), so its country is at most two levels
  // up. Only a final region with a 3-letter country code counts, so continents and World aren't
  // counted as countries.
  const res = await db.query<{ country_name: string; photo_count: number }>(
    `SELECT country.name AS country_name, COUNT(*)::int AS photo_count
     FROM captures c
     JOIN regions leaf ON leaf.id = c.region_id
     LEFT JOIN regions up1 ON up1.id = COALESCE(leaf.home_country_id, leaf.parent_id)
     JOIN regions country ON country.id = (CASE WHEN leaf.external_codes[1] ~ '^[A-Z]{3}$' THEN leaf.id
                                                WHEN up1.external_codes[1] ~ '^[A-Z]{3}$' THEN up1.id
                                                ELSE up1.parent_id END)
     WHERE c.user_id = $1 AND c.region_id IS NOT NULL AND ${scope}
       AND country.external_codes[1] ~ '^[A-Z]{3}$'
     GROUP BY country.name ORDER BY photo_count DESC`,
    [userId],
  );
  return {
    count: res.rows.length,
    countries: res.rows.map((r) => ({ name: r.country_name, photoCount: r.photo_count })),
  };
}

async function loadTotalKeepers(db: Db, userId: string, scope: string): Promise<number> {
  const res = await db.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM captures c WHERE c.user_id = $1 AND ${scope}`,
    [userId],
  );
  return res.rows[0]?.count ?? 0;
}

// Same Ghost/Lost derivation as collectionItem.ts, scoped to collected species only.
async function loadGhostLost(db: Db, userId: string, maxDepthM: number) {
  const res = await db.query<{
    species_id: string;
    scientific_name: string;
    common_name: string | null;
    taxon_class: string;
    reference_photo: string | null;
    occurrence_count: number | null;
    last_occurrence_year: number | null;
    depth_min_m: string | number | null;
    was_ghost_when_collected: boolean | null;
    was_lost_when_collected: boolean | null;
  }>(
    `SELECT s.id AS species_id, s.scientific_name, s.common_name, s.taxon_class, s.reference_photo,
            t.occurrence_count, t.last_occurrence_year, t.depth_min_m,
            us.was_ghost_when_collected, us.was_lost_when_collected
     FROM user_species us
     JOIN species s ON s.id = us.species_id
     LEFT JOIN species_traits t ON t.species_id = s.id
     WHERE us.user_id = $1 AND us.state = 'collected'`,
    [userId],
  );
  const summary = (row: (typeof res.rows)[number]) => ({
    speciesId: row.species_id,
    scientificName: row.scientific_name,
    commonName: row.common_name,
  });
  const isGhost = (row: (typeof res.rows)[number]) => isGhostSpecies(row as CollectionRow, maxDepthM);
  const isLost = (row: (typeof res.rows)[number]) => isLostSpecies(row as CollectionRow);
  return {
    ghostSpecies: res.rows.filter(isGhost).map(summary),
    lostSpecies: res.rows.filter(isLost).map(summary),
    // Ghost/Lost when collected but no longer; current Ghost/Lost species are counted above.
    rediscoveredSpecies: res.rows
      .filter(
        (row) =>
          (row.was_ghost_when_collected === true && !isGhost(row)) ||
          (row.was_lost_when_collected === true && !isLost(row)),
      )
      .map(summary),
  };
}

export interface InsightInputs {
  totalKeepers: number;
  topCamera: { model: string; photoCount: number } | null;
  focalLength: { buckets: Array<{ label: string; count: number }>; total: number };
  timeOfDay: Array<{ hour: number; count: number }>;
  perMonth: Array<{ month: string; newLifers: number }>;
  ghostCount: number;
  lostCount: number;
  rediscoveredCount: number;
}

/** Insight cards, only when there's enough data to say something meaningful. */
export function overviewInsights(input: InsightInputs): string[] {
  const insights: string[] = [];
  if (input.topCamera && input.totalKeepers > 0) {
    const pct = Math.round((input.topCamera.photoCount / input.totalKeepers) * 100);
    if (pct >= 30) insights.push(`You photographed ${pct}% of your keepers with the ${input.topCamera.model}.`);
  }
  if (input.focalLength.total >= 5) {
    const top = [...input.focalLength.buckets].sort((a, b) => b.count - a.count)[0];
    const pct = Math.round((top.count / input.focalLength.total) * 100);
    if (top.count > 0 && pct >= 25) insights.push(`${pct}% of your keepers were shot in the ${top.label} range.`);
  }
  const hours = input.timeOfDay.filter((h) => h.count > 0);
  if (hours.length > 0) {
    const busiest = [...hours].sort((a, b) => b.count - a.count)[0];
    const total = hours.reduce((sum, r) => sum + r.count, 0);
    const pct = Math.round((busiest.count / total) * 100);
    if (pct >= 15)
      insights.push(`Your most productive hour is ${fullHourLabel(busiest.hour)}, ${pct}% of your keepers.`);
  }
  if (input.perMonth.length >= 3) {
    const bestMonth = [...input.perMonth].sort((a, b) => b.newLifers - a.newLifers)[0];
    if (bestMonth.newLifers >= 2) {
      const [year, m] = bestMonth.month.split("-");
      const monthName = new Date(Number(year), Number(m) - 1, 1).toLocaleString("en-US", { month: "long" });
      insights.push(
        `${monthName} ${year} was your best month, ${bestMonth.newLifers} new lifer${bestMonth.newLifers === 1 ? "" : "s"}.`,
      );
    }
  }
  // Only mentioned when the user has one; "0 ghost species" is noise.
  if (input.ghostCount > 0) {
    insights.push(
      `You've photographed ${input.ghostCount} Ghost species, rarely documented anywhere, but you found ${input.ghostCount === 1 ? "one" : "them"}.`,
    );
  }
  if (input.lostCount > 0) {
    insights.push(`You've photographed ${input.lostCount} Lost species, not recorded anywhere else in over 25 years.`);
  }
  if (input.rediscoveredCount > 0) {
    const one = input.rediscoveredCount === 1;
    insights.push(
      `You helped rediscover ${input.rediscoveredCount} species that ${one ? "was" : "were"} Ghost or Lost when you found ${one ? "it" : "them"}.`,
    );
  }
  return insights;
}

export async function loadStatsOverview(db: Db, userId: string, filter: PhotoFilter, maxDepthM: number) {
  const scope = `${KEEPER_FILTER} ${photoFilterFragment(filter)}`;
  const pending = [
    loadPerMonth(db, userId),
    loadGearUsage(db, userId, scope),
    loadTimeOfDay(db, userId, scope),
    loadExifBuckets(db, userId, scope),
    loadScatter(db, userId, scope),
    loadCountries(db, userId, scope),
    loadTotalKeepers(db, userId, scope),
    loadGhostLost(db, userId, maxDepthM),
  ] as const;
  const [perMonth, gearUsage, timeOfDay, exifRows, scatter, countriesPhotographed, totalKeepers, ghostLost] =
    await allSettledOrThrow(pending);

  const focal = bucketsFor(exifRows, "focalLength");
  const distribution = (dim: ExifDimension) =>
    bucketsFor(exifRows, dim).buckets.map(({ label, count, photoIds }) => ({ label, count, photoIds }));
  const insights = overviewInsights({
    totalKeepers,
    topCamera: gearUsage.cameras[0] ?? null,
    focalLength: focal,
    timeOfDay,
    perMonth,
    ghostCount: ghostLost.ghostSpecies.length,
    lostCount: ghostLost.lostSpecies.length,
    rediscoveredCount: ghostLost.rediscoveredSpecies.length,
  });

  return {
    totalKeepers,
    insights,
    ...ghostLost,
    perMonth,
    gearUsage,
    timeOfDay,
    exifDistributions: {
      // A capped sample of photo ids per bucket, so a chart bar can open its photos.
      focalLength: distribution("focalLength"),
      iso: distribution("iso"),
      aperture: distribution("aperture"),
      shutter: distribution("shutter"),
    },
    hitRateByFocalLength: focal.buckets.map(({ label, species }) => ({ label, species })),
    scatter,
    countriesPhotographed,
  };
}
