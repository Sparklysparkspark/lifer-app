// A browsable gallery of every photo you've taken, across all species — separate from the
// per-species detail view, for just scrolling your own collection like a photo library.
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireScope } from "../auth/session.js";
import { EMBEDDING_MODEL_VERSION } from "../config.js";
import { parseSearchQuery, rankSearch, type PlaceEntry, type SearchRow, type SpeciesEntry } from "./photoSearch.js";
import type { GroupPredicate } from "./searchTaxonSynonyms.js";

/** Sentinel passed as `regionId` for the "Uncategorized" filter — not a real region row, just a
 *  way to ask for captures with no region set at all (so they can be found and assigned one). */
export const UNCATEGORIZED_REGION_ID = "uncategorized";

/** A region filter matches that region AND every descendant in the regions tree (picking
 * "World" — or any continent/country — surfaces every photo under it, not just captures
 * tagged with that exact row) — a recursive walk down parent_id from the picked region.
 * Picking World itself (the one region with no parent) also pulls in captures with NO region
 * set at all — otherwise "World" would quietly hide every photo that's never been assigned a
 * region, which reads as "my library is missing photos" rather than "these aren't tagged yet". */
function regionMatchClause(paramIdx: number | null): string {
  if (!paramIdx) return "";
  return `AND (
             c.region_id IN (
               WITH RECURSIVE region_tree AS (
                 SELECT id FROM regions WHERE id = $${paramIdx}
                 UNION ALL
                 SELECT r.id FROM regions r JOIN region_tree rt ON r.parent_id = rt.id
               )
               SELECT id FROM region_tree
             )
             OR (c.region_id IS NULL AND EXISTS (SELECT 1 FROM regions WHERE id = $${paramIdx} AND parent_id IS NULL))
           )`;
}


// Shared by both routes below: species/taxon columns + the RAW/original bookkeeping every
// gallery item needs, as one string so a taxon filter or the "include RAW-derived photos"
// toggle never has to be wired into just one of the two endpoints and not the other.
export const GALLERY_ITEM_COLUMNS = `
  c.id AS capture_id, p.id AS photo_id, p.width, p.height, c.species_id, s.scientific_name, s.common_name, s.taxon_class,
  c.taken_at, c.created_at, c.camera_model, c.lens, c.focal_length_mm, c.aperture, c.shutter, c.iso, c.quality_rating,
  c.lat, c.lon, c.region_id, reg.name AS region_name, p.kind AS photo_kind, p.duration_seconds, c.tags,
  (p.id = us.cover_photo_id) AS is_featured,
  EXISTS (SELECT 1 FROM originals ro WHERE ro.capture_id = c.id AND ro.kind = 'raw') AS has_raw_original,
  o.ref AS original_ref, o.managed AS original_managed, o.kind AS original_kind,
  (SELECT rr.ref FROM originals rr WHERE rr.capture_id = c.id AND rr.kind = 'raw' LIMIT 1) AS raw_ref
`;
export const GALLERY_ITEM_JOINS = `
  JOIN photos p ON p.id = c.current_photo_id
  JOIN species s ON s.id = c.species_id
  LEFT JOIN user_species us ON us.user_id = c.user_id AND us.species_id = c.species_id
  LEFT JOIN regions reg ON reg.id = c.region_id
  -- jpeg-preferred tiebreak (same as SpeciesDetailPage's own capture query) — original_kind
  -- from THIS row is what "include RAW-derived photos" filters against: a capture whose only
  -- original is a RAW file has no jpeg to win the tiebreak, so this resolves to 'raw'.
  LEFT JOIN LATERAL (
    SELECT * FROM originals lo WHERE lo.capture_id = c.id ORDER BY (lo.kind = 'jpeg') DESC LIMIT 1
  ) o ON true
`;

// Search runs on every pause in typing, twice (a quick pass and a full one), and each read every
// photo's details. Kept per user and filter set, and reused while the library is unchanged: one
// cheap check (how many photos, when one last changed, when a vector was last computed) tells a
// new upload, edit, rating or vector apart from nothing having happened. A minute at most, for
// changes that don't touch a photo row (a new cover, a catalog update).
const SEARCH_ROWS_TTL_MS = 60_000;
const searchRowsCache = new Map<string, { stamp: string; at: number; rows: SearchRow[] }>();
// Every photo's vector is in these rows, so they're dropped once stale instead of kept until the
// next search replaces them.
setInterval(() => {
  const now = Date.now();
  for (const [key, hit] of searchRowsCache) if (now - hit.at >= SEARCH_ROWS_TTL_MS) searchRowsCache.delete(key);
}, 60_000).unref();

async function searchRows(userId: string, sql: string, params: unknown[]): Promise<{ rows: SearchRow[] }> {
  const stampRes = await pool.query<{ stamp: string }>(
    `SELECT concat_ws('|', count(*), max(c.updated_at),
              (SELECT max(ce.computed_at) FROM capture_embeddings ce JOIN captures_all c2 ON c2.id = ce.capture_id WHERE c2.user_id = $1)) AS stamp
       FROM captures_all c WHERE c.user_id = $1`,
    [userId],
  );
  const stamp = stampRes.rows[0]?.stamp ?? "";
  const key = `${userId}|${sql}|${JSON.stringify(params)}`;
  const hit = searchRowsCache.get(key);
  if (hit && hit.stamp === stamp && Date.now() - hit.at < SEARCH_ROWS_TTL_MS) return { rows: hit.rows };
  const res = await pool.query<SearchRow>(sql, params);
  for (const [k, v] of searchRowsCache) if (k.startsWith(`${userId}|`) && v.stamp !== stamp) searchRowsCache.delete(k);
  if (searchRowsCache.size > 50) searchRowsCache.delete(searchRowsCache.keys().next().value!);
  searchRowsCache.set(key, { stamp, at: Date.now(), rows: res.rows });
  return { rows: res.rows };
}

// Places a query can name: every region your photos are in plus the regions containing them
// ("Canada" for a photo tagged British Columbia), and the free-text locations typed at import.
// "World" is left out: it contains everything.
async function searchablePlaces(userId: string): Promise<PlaceEntry[]> {
  const res = await pool.query<{ kind: "region" | "location"; id: string; name: string }>(
    `WITH RECURSIVE up AS (
       SELECT r.id, r.name, r.parent_id FROM regions r
        WHERE r.id IN (SELECT DISTINCT region_id FROM captures WHERE user_id = $1 AND region_id IS NOT NULL)
       UNION
       SELECT p.id, p.name, p.parent_id FROM regions p JOIN up ON up.parent_id = p.id
     )
     SELECT 'region' AS kind, id::text AS id, name FROM up WHERE parent_id IS NOT NULL
     UNION ALL
     SELECT DISTINCT 'location', location_label, location_label FROM captures
      WHERE user_id = $1 AND location_label IS NOT NULL AND location_label <> ''`,
    [userId],
  );
  return res.rows;
}

// Latin order and family names from the whole catalog, so "Anatidae" or "Passeriformes" is a
// real filter (and can honestly come back empty) rather than a CLIP guess. Cached: the catalog
// changes only on an update.
let latinGroupCache: { at: number; map: Map<string, GroupPredicate> } | null = null;
async function latinGroupNames(): Promise<Map<string, GroupPredicate>> {
  if (latinGroupCache && Date.now() - latinGroupCache.at < 10 * 60_000) return latinGroupCache.map;
  const res = await pool.query<{ kind: "order" | "family"; name: string }>(
    `SELECT DISTINCT 'order' AS kind, lower(taxon_order) AS name FROM species WHERE taxon_order IS NOT NULL
     UNION
     SELECT DISTINCT 'family', lower(family) FROM species WHERE family IS NOT NULL`,
  );
  const map = new Map<string, GroupPredicate>();
  for (const r of res.rows) map.set(r.name, r.kind === "order" ? { orders: [r.name] } : { families: [r.name] });
  latinGroupCache = { at: Date.now(), map };
  return map;
}

// A region and everything inside it, for a place named in a query.
async function regionSubtree(regionIds: string[]): Promise<Set<string>> {
  const res = await pool.query<{ id: string }>(
    `WITH RECURSIVE down AS (
       SELECT id FROM regions WHERE id = ANY($1::uuid[])
       UNION
       SELECT r.id FROM regions r JOIN down d ON r.parent_id = d.id
     )
     SELECT id::text AS id FROM down`,
    [regionIds],
  );
  return new Set(res.rows.map((r) => r.id));
}

export async function galleryRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: {
      q?: string;
      /** 1: skip picture matching and answer at once; the page follows up with the full search. */
      quick?: string;
      onlyTopRated?: string;
      onlyFeatured?: string;
      taxa?: string;
      includeRaw?: string;
      excludeHasRaw?: string;
      onlyHasRaw?: string;
      onlyVideo?: string;
      excludeVideo?: string;
      dateFrom?: string;
      dateTo?: string;
      regionId?: string;
    };
  }>("/gallery/search", { preHandler: requireScope("gallery.read") }, async (request) => {
    const userId = request.user!.id;
    const q = request.query.q?.trim();
    if (!q) return { items: [] };
    // The same filters as the plain /gallery listing, so a search never silently widens past
    // whatever Top rated / Featured / taxa / date / region filter is already checked.
    const onlyTopRated = request.query.onlyTopRated === "1";
    const onlyFeatured = request.query.onlyFeatured === "1";
    const taxa = request.query.taxa?.split(",").filter(Boolean) ?? [];
    const includeRaw = request.query.includeRaw !== "0";
    const excludeHasRaw = request.query.excludeHasRaw === "1";
    const onlyHasRaw = request.query.onlyHasRaw === "1";
    const onlyVideo = request.query.onlyVideo === "1";
    const excludeVideo = request.query.excludeVideo === "1";
    const dateFrom = request.query.dateFrom || null;
    const dateTo = request.query.dateTo || null;
    const regionId = request.query.regionId || null;
    const isUncategorized = regionId === UNCATEGORIZED_REGION_ID;

    const params: unknown[] = [userId, EMBEDDING_MODEL_VERSION];
    const param = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const where = [
      onlyTopRated ? "AND c.quality_rating = 5" : "",
      onlyFeatured ? "AND p.id = us.cover_photo_id" : "",
      taxa.length > 0 ? `AND s.taxon_class = ANY(${param(taxa)})` : "",
      dateFrom ? `AND c.taken_at >= ${param(dateFrom)}::date` : "",
      dateTo ? `AND c.taken_at < (${param(dateTo)}::date + INTERVAL '1 day')` : "",
      isUncategorized ? "AND c.region_id IS NULL" : regionId ? regionMatchClause(Number(param(regionId).slice(1))) : "",
      includeRaw ? "" : "AND o.kind IS DISTINCT FROM 'raw'",
      onlyVideo ? "AND p.kind = 'video'" : excludeVideo ? "AND p.kind IS DISTINCT FROM 'video'" : "",
      excludeHasRaw
        ? "AND NOT EXISTS (SELECT 1 FROM originals hr WHERE hr.capture_id = c.id AND hr.kind = 'raw')"
        : onlyHasRaw
          ? "AND EXISTS (SELECT 1 FROM originals hr WHERE hr.capture_id = c.id AND hr.kind = 'raw')"
          : "",
    ].join("\n           ");
    // LEFT JOIN on the vector: a photo without one (species matching not downloaded, or not
    // computed yet) is still found by name, group, place and date, just not by what's in it.
    const res = await searchRows(
      userId,
      `SELECT ${GALLERY_ITEM_COLUMNS},
              c.location_label, s.common_name_aliases, s.aba_code, s.ebird_code, s.taxon_order, s.family,
              ce.computed_at::text AS embedding_computed_at
         FROM captures c
         ${GALLERY_ITEM_JOINS}
         LEFT JOIN capture_embeddings ce ON ce.capture_id = c.id AND ce.model_version = $2
         WHERE c.user_id = $1
           ${where}`,
      params,
    );

    const speciesById = new Map<string, SpeciesEntry>();
    for (const r of res.rows) {
      if (speciesById.has(r.species_id)) continue;
      speciesById.set(r.species_id, {
        id: r.species_id,
        commonName: r.common_name,
        scientificName: r.scientific_name,
        taxonClass: r.taxon_class,
        taxonOrder: r.taxon_order,
        family: r.family,
        aliases: (r.common_name_aliases as string[] | null) ?? [],
        codes: [r.aba_code, r.ebird_code].filter((c): c is string => typeof c === "string" && c.length > 0),
      });
    }
    const parsed = parseSearchQuery(q, {
      species: [...speciesById.values()],
      places: await searchablePlaces(userId),
      latinGroups: await latinGroupNames(),
    }, { partialWordPicksSpecies: request.query.quick === "1" });
    const outcome = await rankSearch(q, parsed, res.rows, regionSubtree, { quick: request.query.quick === "1" });
    return {
      items: outcome.items.map(({ row, score }) => toGalleryItem(row, score)),
      interpretation: outcome.interpretation,
      pending: outcome.pending ?? false,
    };
  });

  app.get<{
    Querystring: {
      onlyTopRated?: string;
      onlyFeatured?: string;
      taxa?: string;
      includeRaw?: string;
      excludeHasRaw?: string;
      onlyHasRaw?: string;
      missingDate?: string;
      dateFrom?: string;
      dateTo?: string;
      sort?: string;
      regionId?: string;
      tag?: string;
      onlyVideo?: string;
      excludeVideo?: string;
    };
  }>("/gallery", { preHandler: requireScope("gallery.read") }, async (request) => {
    const userId = request.user!.id;
    const onlyTopRated = request.query.onlyTopRated === "1";
    const onlyFeatured = request.query.onlyFeatured === "1";
    const taxa = request.query.taxa?.split(",").filter(Boolean) ?? [];
    const includeRaw = request.query.includeRaw !== "0";
    const excludeHasRaw = request.query.excludeHasRaw === "1";
    const onlyHasRaw = request.query.onlyHasRaw === "1";
    const hasRawClause = excludeHasRaw
      ? "AND NOT EXISTS (SELECT 1 FROM originals hr WHERE hr.capture_id = c.id AND hr.kind = 'raw')"
      : onlyHasRaw
        ? "AND EXISTS (SELECT 1 FROM originals hr WHERE hr.capture_id = c.id AND hr.kind = 'raw')"
        : "";
    const onlyVideo = request.query.onlyVideo === "1";
    const excludeVideo = request.query.excludeVideo === "1";
    // Unrated (never NULL == 0 stars) sorts as a middle 3 — an unrated photo isn't necessarily
    // BAD, it's just unrated, so ratingHigh/ratingLow shouldn't sink it to one extreme end.
    const orderBy =
      request.query.sort === "oldest"
        ? "c.taken_at ASC NULLS LAST, c.created_at ASC"
        : request.query.sort === "ratingHigh"
          ? "COALESCE(c.quality_rating, 3) DESC, c.taken_at DESC NULLS LAST"
          : request.query.sort === "ratingLow"
            ? "COALESCE(c.quality_rating, 3) ASC, c.taken_at DESC NULLS LAST"
            : "c.taken_at DESC NULLS LAST, c.created_at DESC";
    // Drill-down from the Stats page's Archive health card — every capture with no taken_at,
    // so "41 photos missing a date" turns into an actual view to go fix instead of just a
    // number (see PATCH /captures/:id/taken-at, which this view's date input calls).
    const missingDate = request.query.missingDate === "1";
    // Plain YYYY-MM-DD from a native <input type="date"> — dateTo is inclusive of the whole day
    // (< the next day), not just up to midnight, so picking the same day for both ends actually
    // includes that day's photos instead of showing nothing.
    const dateFrom = request.query.dateFrom || null;
    const dateTo = request.query.dateTo || null;
    const regionId = request.query.regionId || null;
    const isUncategorized = regionId === UNCATEGORIZED_REGION_ID;
    const tag = request.query.tag || null;
    const params: unknown[] = [userId];
    if (taxa.length > 0) params.push(taxa);
    const taxaParamIdx = taxa.length > 0 ? params.length : null;
    if (dateFrom) params.push(dateFrom);
    const dateFromParamIdx = dateFrom ? params.length : null;
    if (dateTo) params.push(dateTo);
    const dateToParamIdx = dateTo ? params.length : null;
    if (regionId && !isUncategorized) params.push(regionId);
    const regionParamIdx = regionId && !isUncategorized ? params.length : null;
    if (tag) params.push(tag);
    const tagParamIdx = tag ? params.length : null;

    // "Featured" compares this photo's id against user_species.cover_photo_id for the SAME
    // species — a per-species single pick (set from either SpeciesDetailPage.tsx or this
    // page's own toggle, via PATCH /species/:id/cover), not a photo-level flag of its own.
    const res = await pool.query(
      `SELECT ${GALLERY_ITEM_COLUMNS}
         FROM captures c
         ${GALLERY_ITEM_JOINS}
         WHERE c.user_id = $1
           ${onlyTopRated ? "AND c.quality_rating = 5" : ""}
           ${onlyFeatured ? "AND p.id = us.cover_photo_id" : ""}
           ${missingDate ? "AND c.taken_at IS NULL" : ""}
           ${taxaParamIdx ? `AND s.taxon_class = ANY($${taxaParamIdx})` : ""}
           ${dateFromParamIdx ? `AND c.taken_at >= $${dateFromParamIdx}::date` : ""}
           ${dateToParamIdx ? `AND c.taken_at < ($${dateToParamIdx}::date + INTERVAL '1 day')` : ""}
           ${isUncategorized ? "AND c.region_id IS NULL" : regionMatchClause(regionParamIdx)}
           ${tagParamIdx ? `AND $${tagParamIdx} = ANY(c.tags)` : ""}
           ${includeRaw ? "" : "AND o.kind IS DISTINCT FROM 'raw'"}
           ${hasRawClause}
           ${onlyVideo ? "AND p.kind = 'video'" : ""}
           ${excludeVideo ? "AND p.kind IS DISTINCT FROM 'video'" : ""}
         ORDER BY ${orderBy}`,
      params,
    );

    return { items: res.rows.map((row) => toGalleryItem(row, null)) };
  });

  // Existence check for the frontend's "Video" filter — that toggle should only render when the
  // user actually has at least one video, so this is a cheap `EXISTS` rather than a real count.
  app.get("/gallery/has-video", { preHandler: requireScope("gallery.read") }, async (request) => {
    const userId = request.user!.id;
    const res = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM photos p JOIN captures c ON c.id = p.capture_id
         WHERE c.user_id = $1 AND p.kind = 'video'
       ) AS exists`,
      [userId],
    );
    return { hasVideo: res.rows[0]?.exists ?? false };
  });

  // Which taxon classes the Taxon filter should even offer — the full ALL_TAXON_CLASSES list
  // includes plenty a given user has never photographed, and checking one of those always
  // yields zero results, which reads as a bug rather than "this filter is just empty for you".
  app.get("/gallery/taxa", { preHandler: requireScope("gallery.read") }, async (request) => {
    const userId = request.user!.id;
    const res = await pool.query<{ taxon_class: string }>(
      `SELECT DISTINCT s.taxon_class
         FROM captures c
         JOIN species s ON s.id = c.species_id
         WHERE c.user_id = $1`,
      [userId],
    );
    return { taxa: res.rows.map((r) => r.taxon_class) };
  });

  // Which regions the Region filter should even offer — Gallery's own picker previously used
  // RegionBrowser's `allowAnyRegion` mode (meant for admin-style pickers with no downloaded-pack
  // notion), which showed literally every region in the taxonomy regardless of whether the user's
  // library has any photos tagged there at all. Includes every ancestor of a region actually used
  // (so drilling from World -> continent -> country still finds its way to a real leaf) —
  // RegionBrowser's own tree only renders a node whose id (or an ancestor's) is in this set.
  app.get("/gallery/regions-with-photos", { preHandler: requireScope("gallery.read") }, async (request) => {
    const userId = request.user!.id;
    const res = await pool.query<{ id: string }>(
      `WITH RECURSIVE used AS (
         SELECT DISTINCT region_id AS id FROM captures WHERE user_id = $1 AND region_id IS NOT NULL
       ),
       ancestors AS (
         SELECT id FROM used
         UNION
         SELECT r.parent_id FROM regions r JOIN ancestors a ON r.id = a.id WHERE r.parent_id IS NOT NULL
       )
       SELECT DISTINCT id FROM ancestors`,
      [userId],
    );
    return { regionIds: res.rows.map((r) => r.id) };
  });
}

// Shared response shape between /gallery and /gallery/search — score is null for the plain
// (unsearched) listing, since "match quality" isn't a meaningful concept there.
export function toGalleryItem(row: Record<string, unknown>, score: number | null) {
  return {
    photoId: row.photo_id,
    width: row.width,
    height: row.height,
    captureId: row.capture_id,
    speciesId: row.species_id,
    scientificName: row.scientific_name,
    commonName: row.common_name,
    taxonClass: row.taxon_class,
    takenAt: row.taken_at,
    cameraModel: row.camera_model,
    lens: row.lens,
    focalLengthMm: row.focal_length_mm,
    aperture: row.aperture,
    shutter: row.shutter,
    iso: row.iso,
    qualityRating: row.quality_rating,
    lat: row.lat,
    lon: row.lon,
    regionId: row.region_id,
    regionName: row.region_name,
    kind: row.photo_kind ?? "image",
    durationSeconds: row.duration_seconds,
    tags: row.tags ?? [],
    isFeatured: row.is_featured,
    hasRawOriginal: row.has_raw_original,
    originalRef: row.original_ref,
    originalManaged: row.original_managed,
    originalKind: row.original_kind,
    rawRef: row.raw_ref ?? null,
    matchScore: score,
  };
}
