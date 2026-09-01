import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireAuth } from "../auth/session.js";
import { isGhostSpecies, isLostSpecies, type CollectionRow } from "../collection/collectionItem.js";
import { getObscurityPreferences } from "../species/obscurity.js";

// "Keeper" = a capture with an actual edited/adjusted photo attached, not a RAW-only import
// sitting in the backlog unedited (see migration 007_originals.sql's own kind CHECK — a capture
// can have a 'raw' original with no 'jpeg' sibling yet), AND not rated 1 star. The 1-star
// exclusion is deliberate: a 1-star rating is how a photographer marks "I edited this enough to
// confirm the ID, but it's not a real keeper" (an ID shot, a blown-out backup frame, etc) — those
// shouldn't skew gear/EXIF/timeline stats just because they went through the same edit pipeline
// as everything else. Every stats query below is scoped to this so stats reflect what was
// actually finished and kept, not the raw backlog most photographers shoot far more of than they
// ever process, and not the "kept only to confirm an ID" throwaways either.
const KEEPER_FILTER = `EXISTS (SELECT 1 FROM originals o WHERE o.capture_id = c.id AND o.kind = 'jpeg') AND (c.quality_rating IS NULL OR c.quality_rating > 1)`;

type PhotoFilter = "all" | "featured" | "topRated";

// "featured" = the species' own cover photo (user_species.cover_photo_id, same thing
// GalleryPage.tsx's isFeatured already means — there's no separate featured flag on
// captures/photos, a species just has one designated cover). "topRated" = a 5-star
// quality_rating. Both narrow every capture-scoped query below; the discovery-timeline/
// new-lifers-per-month widgets are about species first_collected dates, not individual photos,
// so they're deliberately left unfiltered regardless of this param.
function photoFilterFragment(filter: PhotoFilter): string {
  if (filter === "featured") {
    return `AND c.current_photo_id = (SELECT us.cover_photo_id FROM user_species us WHERE us.user_id = c.user_id AND us.species_id = c.species_id)`;
  }
  if (filter === "topRated") {
    return `AND c.quality_rating = 5`;
  }
  return "";
}

// exiftool-vendored's ShutterSpeed can come back either as a plain decimal-seconds string
// ("0.0005") or a fraction ("1/2000") depending on the tag/camera — handle both rather than
// assuming one format holds for every capture in a library that may span years of different gear.
function parseShutterSeconds(raw: string): number | null {
  const fraction = raw.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (fraction) {
    const denominator = Number(fraction[2]);
    return denominator > 0 ? Number(fraction[1]) / denominator : null;
  }
  const plain = Number(raw);
  return Number.isFinite(plain) && plain > 0 ? plain : null;
}

function shutterLabel(seconds: number): string {
  return seconds >= 1 ? `${seconds}s` : `1/${Math.round(1 / seconds)}`;
}

interface Bucket {
  label: string;
  min: number;
  max: number;
}

function bucketize(values: number[], buckets: Bucket[]): Array<{ label: string; count: number }> {
  const counts = new Map(buckets.map((b) => [b.label, 0]));
  for (const v of values) {
    const bucket = buckets.find((b) => v >= b.min && v < b.max);
    if (bucket) counts.set(bucket.label, (counts.get(bucket.label) ?? 0) + 1);
  }
  return buckets.map((b) => ({ label: b.label, count: counts.get(b.label) ?? 0 }));
}

function bucketizeDistinct(rows: Array<{ value: number; speciesId: string }>, buckets: Bucket[]): Array<{ label: string; species: number }> {
  const sets = new Map(buckets.map((b) => [b.label, new Set<string>()]));
  for (const { value, speciesId } of rows) {
    const bucket = buckets.find((b) => value >= b.min && value < b.max);
    if (bucket) sets.get(bucket.label)!.add(speciesId);
  }
  return buckets.map((b) => ({ label: b.label, species: sets.get(b.label)!.size }));
}

const FOCAL_LENGTH_BUCKETS: Bucket[] = [
  { label: "0-100mm", min: 0, max: 100 },
  { label: "100-200mm", min: 100, max: 200 },
  { label: "200-300mm", min: 200, max: 300 },
  { label: "300-400mm", min: 300, max: 400 },
  { label: "400-500mm", min: 400, max: 500 },
  { label: "500-600mm", min: 500, max: 600 },
  { label: "600-800mm", min: 600, max: 800 },
  { label: "800mm+", min: 800, max: Infinity },
];
const ISO_BUCKETS: Bucket[] = [
  { label: "≤200", min: 0, max: 201 },
  { label: "400", min: 201, max: 401 },
  { label: "800", min: 401, max: 801 },
  { label: "1600", min: 801, max: 1601 },
  { label: "3200", min: 1601, max: 3201 },
  { label: "6400+", min: 3201, max: Infinity },
];
const APERTURE_BUCKETS: Bucket[] = [
  { label: "f/1.0-2.0", min: 1, max: 2 },
  { label: "f/2.0-2.8", min: 2, max: 2.8 },
  { label: "f/2.8-4.0", min: 2.8, max: 4 },
  { label: "f/4.0-5.6", min: 4, max: 5.6 },
  { label: "f/5.6-8.0", min: 5.6, max: 8 },
  { label: "f/8.0+", min: 8, max: Infinity },
];
// Fastest-first, matching how photographers actually think about shutter speed. The fastest
// bucket used to be a single "≥1/4000" catch-all — a photographer with genuinely extreme
// electronic-shutter speeds (1/16000, 1/32000+) just disappeared into that one bucket with no
// visibility into how fast they actually were. Split further out instead of capping at a fixed
// placeholder ceiling.
const SHUTTER_BUCKETS: Bucket[] = [
  { label: "≥1/16000", min: 0, max: 1 / 16000 },
  { label: "1/8000-1/16000", min: 1 / 16000, max: 1 / 8000 },
  { label: "1/4000-1/8000", min: 1 / 8000, max: 1 / 4000 },
  { label: "1/2000-1/4000", min: 1 / 4000, max: 1 / 2000 },
  { label: "1/1000-1/2000", min: 1 / 2000, max: 1 / 1000 },
  { label: "1/500-1/1000", min: 1 / 1000, max: 1 / 500 },
  { label: "1/250-1/500", min: 1 / 500, max: 1 / 250 },
  { label: "1/125-1/250", min: 1 / 250, max: 1 / 125 },
  { label: "≤1/125", min: 1 / 125, max: Infinity },
];

function fullHourLabel(hour: number): string {
  if (hour === 0) return "12 AM";
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return "12 PM";
  return `${hour - 12} PM`;
}

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { filter?: string } }>("/stats", { preHandler: requireAuth }, async (request) => {
    const userId = request.user!.id;
    const filter: PhotoFilter = request.query.filter === "featured" || request.query.filter === "topRated" ? request.query.filter : "all";
    const scope = `${KEEPER_FILTER} ${photoFilterFragment(filter)}`;

    const { maxDepthM } = await getObscurityPreferences(userId);

    const [
      timelineRes,
      keepersPerMonthRes,
      cameraRes,
      lensRes,
      comboRes,
      timeOfDayRes,
      exifRes,
      scatterRes,
      countriesRes,
      totalKeepersRes,
      ghostLostRes,
    ] = await Promise.all([
      pool.query<{ date: string; count: number }>(
        `SELECT us.first_collected::text AS date, COUNT(*)::int AS count
         FROM user_species us WHERE us.user_id = $1 AND us.state = 'collected' AND us.first_collected IS NOT NULL
         GROUP BY us.first_collected ORDER BY us.first_collected`,
        [userId],
      ),
      // Keepers-per-month is the "total keepers" axis on the same monthly chart new-lifers-
      // per-month uses — grouped by taken_at (when the photo happened), not by first_collected
      // (when a species was first added), since a keeper doesn't have to be a new lifer at all.
      // Deliberately left unfiltered by the featured/topRated photoFilterFragment, same as
      // newLifersPerMonth, so switching the dropdown doesn't also silently change what "all
      // keepers" means for the timeline.
      pool.query<{ month: string; count: number }>(
        `SELECT to_char(c.taken_at, 'YYYY-MM') AS month, COUNT(*)::int AS count
         FROM captures c WHERE c.user_id = $1 AND c.taken_at IS NOT NULL AND ${KEEPER_FILTER}
         GROUP BY month ORDER BY month`,
        [userId],
      ),
      pool.query<{ camera_model: string; photo_count: number; species_count: number }>(
        `SELECT c.camera_model, COUNT(*)::int AS photo_count, COUNT(DISTINCT c.species_id)::int AS species_count
         FROM captures c WHERE c.user_id = $1 AND c.camera_model IS NOT NULL AND ${scope}
         GROUP BY c.camera_model ORDER BY photo_count DESC`,
        [userId],
      ),
      pool.query<{ lens: string; photo_count: number; species_count: number }>(
        `SELECT c.lens, COUNT(*)::int AS photo_count, COUNT(DISTINCT c.species_id)::int AS species_count
         FROM captures c WHERE c.user_id = $1 AND c.lens IS NOT NULL AND ${scope}
         GROUP BY c.lens ORDER BY photo_count DESC`,
        [userId],
      ),
      pool.query<{ camera_model: string; lens: string; photo_count: number; species_count: number }>(
        `SELECT c.camera_model, c.lens, COUNT(*)::int AS photo_count, COUNT(DISTINCT c.species_id)::int AS species_count
         FROM captures c WHERE c.user_id = $1 AND c.camera_model IS NOT NULL AND c.lens IS NOT NULL AND ${scope}
         GROUP BY c.camera_model, c.lens ORDER BY photo_count DESC LIMIT 10`,
        [userId],
      ),
      pool.query<{ hour: number; count: number }>(
        `SELECT EXTRACT(HOUR FROM c.taken_at)::int AS hour, COUNT(*)::int AS count
         FROM captures c WHERE c.user_id = $1 AND c.taken_at IS NOT NULL AND ${scope}
         GROUP BY hour ORDER BY hour`,
        [userId],
      ),
      pool.query<{ focal_length_mm: string | null; aperture: string | null; shutter: string | null; iso: number | null; species_id: string }>(
        `SELECT c.focal_length_mm, c.aperture, c.shutter, c.iso, c.species_id
         FROM captures c WHERE c.user_id = $1 AND ${scope}`,
        [userId],
      ),
      pool.query<{
        focal_length_mm: string | null;
        aperture: string | null;
        shutter: string | null;
        iso: number | null;
        scientific_name: string;
        common_name: string | null;
        photo_id: string | null;
      }>(
        // photo_id, not a stored path — thumbnails are served through GET /photos/:id/thumb
        // (see photos/routes.ts), same convention GalleryPage.tsx already uses.
        `SELECT c.focal_length_mm, c.aperture, c.shutter, c.iso, s.scientific_name, s.common_name, p.id AS photo_id
         FROM captures c
         JOIN species s ON s.id = c.species_id
         LEFT JOIN photos p ON p.id = c.current_photo_id
         WHERE c.user_id = $1 AND ${scope}
         ORDER BY c.taken_at DESC NULLS LAST LIMIT 1500`,
        [userId],
      ),
      // A capture's region may be a province (child of a country) or a country itself — resolve
      // one level up only, since the schema never nests provinces further (World -> continent ->
      // country -> province, flat). See migration 067's own comment on why region_id exists.
      pool.query<{ country_name: string; photo_count: number }>(
        `SELECT country.name AS country_name, COUNT(*)::int AS photo_count
         FROM captures c
         JOIN regions leaf ON leaf.id = c.region_id
         JOIN regions country ON country.id = (CASE WHEN leaf.external_codes[1] ~ '^[A-Z]{3}$' THEN leaf.id ELSE leaf.parent_id END)
         WHERE c.user_id = $1 AND c.region_id IS NOT NULL AND ${scope}
         GROUP BY country.name ORDER BY photo_count DESC`,
        [userId],
      ),
      pool.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM captures c WHERE c.user_id = $1 AND ${scope}`, [userId]),
      // Same Ghost/Lost derivation collectionItem.ts uses, just scoped to species this user has
      // actually collected (state='collected') — the whole point of these badges/insights is
      // "you personally found one of these," per the user's own explicit gating requirement.
      pool.query<{
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
      ),
    ]);

    // One merged per-month series backing both axes of the "new lifers / total keepers"
    // chart — the frontend's own dropdown picks which count to plot, rather than this being
    // two separate endpoints/charts (see StatsPage.tsx's own comment on replacing the old
    // "cumulative lifers" area chart with this).
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
    const perMonth = [...monthCounts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, counts]) => {
        const [year, m] = month.split("-");
        const label = new Date(Number(year), Number(m) - 1, 1).toLocaleString("en-US", { month: "short", year: "2-digit" });
        return { month, label, newLifers: counts.newLifers, keepers: counts.keepers };
      });

    const timeOfDay = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      label: fullHourLabel(hour),
      count: timeOfDayRes.rows.find((r) => r.hour === hour)?.count ?? 0,
    }));

    const focalLengths = exifRes.rows.filter((r) => r.focal_length_mm != null).map((r) => Number(r.focal_length_mm));
    const isos = exifRes.rows.filter((r) => r.iso != null).map((r) => r.iso!);
    const apertures = exifRes.rows.filter((r) => r.aperture != null).map((r) => Number(r.aperture));
    const shutters = exifRes.rows
      .filter((r) => r.shutter != null)
      .map((r) => parseShutterSeconds(r.shutter!))
      .filter((s): s is number => s != null);
    const focalLengthBySpecies = exifRes.rows
      .filter((r) => r.focal_length_mm != null)
      .map((r) => ({ value: Number(r.focal_length_mm), speciesId: r.species_id }));

    // Every axis the scatter plot's dropdowns can select between — a point only needs values
    // for whichever two axes are actually picked, so nulls are fine and filtered client-side.
    const scatter = scatterRes.rows.map((r) => {
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
      };
    });

    const totalKeepers = totalKeepersRes.rows[0]?.count ?? 0;

    // Auto-generated insight facts — the "personal fingerprint" cards. Only computed when there's
    // enough data to say something meaningful (an empty/near-empty library just gets no insights,
    // not misleading "100% of 1 photo" claims).
    const insights: string[] = [];
    if (cameraRes.rows.length > 0 && totalKeepers > 0) {
      const top = cameraRes.rows[0];
      const pct = Math.round((top.photo_count / totalKeepers) * 100);
      if (pct >= 30) insights.push(`You photographed ${pct}% of your keepers with the ${top.camera_model}.`);
    }
    if (focalLengths.length >= 5) {
      const buckets = bucketize(focalLengths, FOCAL_LENGTH_BUCKETS).sort((a, b) => b.count - a.count);
      const top = buckets[0];
      const pct = Math.round((top.count / focalLengths.length) * 100);
      if (top.count > 0 && pct >= 25) insights.push(`${pct}% of your keepers were shot in the ${top.label} range.`);
    }
    if (timeOfDayRes.rows.length > 0) {
      const busiest = [...timeOfDayRes.rows].sort((a, b) => b.count - a.count)[0];
      const total = timeOfDayRes.rows.reduce((sum, r) => sum + r.count, 0);
      const pct = Math.round((busiest.count / total) * 100);
      if (pct >= 15) insights.push(`Your most productive hour is ${fullHourLabel(busiest.hour)}, ${pct}% of your keepers.`);
    }
    if (perMonth.length >= 3) {
      const bestMonth = [...perMonth].sort((a, b) => b.newLifers - a.newLifers)[0];
      if (bestMonth.newLifers >= 2) {
        const [year, m] = bestMonth.month.split("-");
        const monthName = new Date(Number(year), Number(m) - 1, 1).toLocaleString("en-US", { month: "long" });
        insights.push(`${monthName} ${year} was your best month, ${bestMonth.newLifers} new lifer${bestMonth.newLifers === 1 ? "" : "s"}.`);
      }
    }

    const ghostSpecies = ghostLostRes.rows
      .filter((row) => isGhostSpecies(row as CollectionRow, maxDepthM))
      .map((row) => ({ speciesId: row.species_id, scientificName: row.scientific_name, commonName: row.common_name }));
    const lostSpecies = ghostLostRes.rows
      .filter((row) => isLostSpecies(row as CollectionRow))
      .map((row) => ({ speciesId: row.species_id, scientificName: row.scientific_name, commonName: row.common_name }));
    // Was flagged the moment it was collected (migration 069's trigger snapshot) but no longer
    // is live, per the same isGhostSpecies/isLostSpecies checks above. Excludes anything still
    // currently Ghost/Lost, which already gets its own badge/section above.
    const rediscoveredSpecies = ghostLostRes.rows
      .filter(
        (row) =>
          (row.was_ghost_when_collected === true && !isGhostSpecies(row as CollectionRow, maxDepthM)) ||
          (row.was_lost_when_collected === true && !isLostSpecies(row as CollectionRow)),
      )
      .map((row) => ({ speciesId: row.species_id, scientificName: row.scientific_name, commonName: row.common_name }));
    // Only worth a mention when the user actually has one, most photographers will never
    // encounter a Ghost or Lost species, so an insight about "0 ghost species" would just read
    // as noise (per the user's explicit "shouldn't take up space" requirement).
    if (ghostSpecies.length > 0) {
      insights.push(
        `You've photographed ${ghostSpecies.length} Ghost species, rarely documented anywhere, but you found ${ghostSpecies.length === 1 ? "one" : "them"}.`,
      );
    }
    if (lostSpecies.length > 0) {
      insights.push(
        `You've photographed ${lostSpecies.length} Lost species, not recorded anywhere else in over 25 years.`,
      );
    }
    if (rediscoveredSpecies.length > 0) {
      insights.push(
        `You helped rediscover ${rediscoveredSpecies.length} species that ${rediscoveredSpecies.length === 1 ? "was" : "were"} Ghost or Lost when you found ${rediscoveredSpecies.length === 1 ? "it" : "them"}.`,
      );
    }

    return {
      totalKeepers,
      insights,
      ghostSpecies,
      lostSpecies,
      rediscoveredSpecies,
      perMonth,
      gearUsage: {
        cameras: cameraRes.rows.map((r) => ({ model: r.camera_model, photoCount: r.photo_count, speciesCount: r.species_count })),
        lenses: lensRes.rows.map((r) => ({ model: r.lens, photoCount: r.photo_count, speciesCount: r.species_count })),
        combos: comboRes.rows.map((r) => ({ camera: r.camera_model, lens: r.lens, photoCount: r.photo_count, speciesCount: r.species_count })),
      },
      timeOfDay,
      exifDistributions: {
        focalLength: bucketize(focalLengths, FOCAL_LENGTH_BUCKETS),
        iso: bucketize(isos, ISO_BUCKETS),
        aperture: bucketize(apertures, APERTURE_BUCKETS),
        shutter: bucketize(shutters, SHUTTER_BUCKETS),
      },
      hitRateByFocalLength: bucketizeDistinct(focalLengthBySpecies, FOCAL_LENGTH_BUCKETS),
      scatter,
      countriesPhotographed: {
        count: countriesRes.rows.length,
        countries: countriesRes.rows.map((r) => ({ name: r.country_name, photoCount: r.photo_count })),
      },
    };
  });

  // One row per keeper capture with every raw EXIF/species field, not the pre-bucketed stats
  // above — a user asking to "build their own charts elsewhere" wants the underlying data, not
  // Lifer's own histogram choices baked in.
  function csvField(value: string | number | null | undefined): string {
    if (value == null) return "";
    const s = String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  app.get<{ Querystring: { filter?: string } }>("/stats/export.csv", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.user!.id;
    const filter: PhotoFilter = request.query.filter === "featured" || request.query.filter === "topRated" ? request.query.filter : "all";
    const scope = `${KEEPER_FILTER} ${photoFilterFragment(filter)}`;

    const res = await pool.query<{
      scientific_name: string;
      common_name: string | null;
      taken_at: string | null;
      camera_model: string | null;
      lens: string | null;
      focal_length_mm: string | null;
      aperture: string | null;
      shutter: string | null;
      iso: number | null;
      quality_rating: number | null;
      country_name: string | null;
    }>(
      `SELECT s.scientific_name, s.common_name, c.taken_at, c.camera_model, c.lens, c.focal_length_mm, c.aperture, c.shutter, c.iso,
              c.quality_rating,
              (SELECT country.name FROM regions leaf JOIN regions country
                 ON country.id = (CASE WHEN leaf.external_codes[1] ~ '^[A-Z]{3}$' THEN leaf.id ELSE leaf.parent_id END)
               WHERE leaf.id = c.region_id) AS country_name
       FROM captures c
       JOIN species s ON s.id = c.species_id
       WHERE c.user_id = $1 AND ${scope}
       ORDER BY c.taken_at ASC NULLS LAST`,
      [userId],
    );

    const header = [
      "scientific_name",
      "common_name",
      "taken_at",
      "camera_model",
      "lens",
      "focal_length_mm",
      "aperture",
      "shutter",
      "iso",
      "quality_rating",
      "country",
    ];
    const lines = [header.join(",")];
    for (const r of res.rows) {
      lines.push(
        [
          csvField(r.scientific_name),
          csvField(r.common_name),
          csvField(r.taken_at),
          csvField(r.camera_model),
          csvField(r.lens),
          csvField(r.focal_length_mm),
          csvField(r.aperture),
          csvField(r.shutter),
          csvField(r.iso),
          csvField(r.quality_rating),
          csvField(r.country_name),
        ].join(","),
      );
    }

    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="lifer-stats-${filter}.csv"`);
    return lines.join("\n");
  });
}
