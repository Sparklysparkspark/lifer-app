// Gallery of every photo across all species, plus photo search.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { pool } from "../db.js";
import { isUuid, parseDate, parseLimit } from "../lib/validate.js";
import { requireScope } from "../auth/session.js";
import { EMBEDDING_MODEL_VERSION } from "../config.js";
import { parseSearchQuery, rankSearch, type PlaceEntry, type SearchRow, type SpeciesEntry } from "./photoSearch.js";
import type { GroupPredicate } from "./searchTaxonSynonyms.js";

/** Sentinel `regionId` for the "Uncategorized" filter: captures with no region set. */
export const UNCATEGORIZED_REGION_ID = "uncategorized";

/** A region filter matches that region and every descendant. The root region (World) also
 *  matches captures with no region, so it never hides untagged photos. */
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

// Columns shared by /gallery and /gallery/search, so filters stay in sync between them.
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
  -- jpeg-preferred tiebreak (same as SpeciesDetailPage's own capture query), original_kind
  -- from THIS row is what "include RAW-derived photos" filters against: a capture whose only
  -- original is a RAW file has no jpeg to win the tiebreak, so this resolves to 'raw'.
  LEFT JOIN LATERAL (
    SELECT * FROM originals lo WHERE lo.capture_id = c.id ORDER BY (lo.kind = 'jpeg') DESC LIMIT 1
  ) o ON true
`;

// The filters /gallery and /gallery/search share, parsed and validated once. Ids and dates that
// wouldn't survive a Postgres cast get a 400 instead of a 500.
export interface GalleryFilters {
  onlyTopRated: boolean;
  onlyFeatured: boolean;
  taxa: string[];
  includeRaw: boolean;
  excludeHasRaw: boolean;
  onlyHasRaw: boolean;
  onlyVideo: boolean;
  excludeVideo: boolean;
  missingDate: boolean;
  dateFrom: string | null;
  dateTo: string | null;
  regionId: string | null;
  tag: string | null;
  tripId: string | null;
  albumId: string | null;
}

type GalleryFilterQuery = Partial<Record<keyof GalleryFilters, string>>;

// Plain YYYY-MM-DD from a native <input type="date">; anything else Postgres can't cast is refused.
function parseDay(value: string | undefined): string | null | undefined {
  if (!value) return null;
  const d = parseDate(value);
  if (!d || !/^\d{4}-\d{2}-\d{2}/.test(value)) return undefined;
  return value.slice(0, 10);
}

export function parseGalleryFilters(q: GalleryFilterQuery): GalleryFilters | { error: string } {
  const dateFrom = parseDay(q.dateFrom);
  const dateTo = parseDay(q.dateTo);
  if (dateFrom === undefined || dateTo === undefined) return { error: "dateFrom and dateTo must be YYYY-MM-DD dates" };
  const regionId = q.regionId || null;
  if (regionId && regionId !== UNCATEGORIZED_REGION_ID && !isUuid(regionId)) return { error: "regionId must be a region id" };
  const tripId = q.tripId || null;
  if (tripId && !isUuid(tripId)) return { error: "tripId must be a trip id" };
  const albumId = q.albumId || null;
  if (albumId && !isUuid(albumId)) return { error: "albumId must be an album id" };
  return {
    onlyTopRated: q.onlyTopRated === "1",
    onlyFeatured: q.onlyFeatured === "1",
    taxa: q.taxa?.split(",").filter(Boolean) ?? [],
    includeRaw: q.includeRaw !== "0",
    excludeHasRaw: q.excludeHasRaw === "1",
    onlyHasRaw: q.onlyHasRaw === "1",
    onlyVideo: q.onlyVideo === "1",
    excludeVideo: q.excludeVideo === "1",
    // Captures with no taken_at (Stats page drill-down).
    missingDate: q.missingDate === "1",
    // dateTo includes the whole day (< the next day).
    dateFrom,
    dateTo,
    regionId,
    tag: q.tag || null,
    tripId,
    albumId,
  };
}

/** The WHERE clauses for a filter set, adding each value through `param` ($n placeholders). */
export function galleryFilterSql(f: GalleryFilters, param: (v: unknown) => string): string {
  const isUncategorized = f.regionId === UNCATEGORIZED_REGION_ID;
  return [
    f.onlyTopRated ? "AND c.quality_rating = 5" : "",
    // "Featured" means this photo is its species' cover_photo_id, not a photo-level flag.
    f.onlyFeatured ? "AND p.id = us.cover_photo_id" : "",
    f.missingDate ? "AND c.taken_at IS NULL" : "",
    f.taxa.length > 0 ? `AND s.taxon_class = ANY(${param(f.taxa)})` : "",
    f.dateFrom ? `AND c.taken_at >= ${param(f.dateFrom)}::date` : "",
    f.dateTo ? `AND c.taken_at < (${param(f.dateTo)}::date + INTERVAL '1 day')` : "",
    isUncategorized ? "AND c.region_id IS NULL" : f.regionId ? regionMatchClause(Number(param(f.regionId).slice(1))) : "",
    f.tag ? `AND ${param(f.tag)} = ANY(c.tags)` : "",
    f.tripId ? `AND c.trip_id = ${param(f.tripId)}::uuid` : "",
    // EXISTS rather than a JOIN so a photo in an album is never listed twice.
    f.albumId ? `AND EXISTS (SELECT 1 FROM album_captures fac WHERE fac.capture_id = c.id AND fac.album_id = ${param(f.albumId)}::uuid)` : "",
    f.includeRaw ? "" : "AND o.kind IS DISTINCT FROM 'raw'",
    f.excludeHasRaw
      ? "AND NOT EXISTS (SELECT 1 FROM originals hr WHERE hr.capture_id = c.id AND hr.kind = 'raw')"
      : f.onlyHasRaw
        ? "AND EXISTS (SELECT 1 FROM originals hr WHERE hr.capture_id = c.id AND hr.kind = 'raw')"
        : "",
    f.onlyVideo ? "AND p.kind = 'video'" : "",
    f.excludeVideo ? "AND p.kind IS DISTINCT FROM 'video'" : "",
  ]
    .filter(Boolean)
    .join("\n           ");
}

// /gallery sort orders. Unrated sorts as a middle 3 so it doesn't sink to either end. c.id breaks
// ties so keyset pages never skip or repeat a photo.
interface SortKey {
  expr: string;
  desc: boolean;
  nullable: boolean;
  cast: string;
}
const GALLERY_SORTS: Record<string, SortKey[]> = {
  newest: [
    { expr: "c.taken_at", desc: true, nullable: true, cast: "timestamptz" },
    { expr: "c.created_at", desc: true, nullable: false, cast: "timestamptz" },
  ],
  oldest: [
    { expr: "c.taken_at", desc: false, nullable: true, cast: "timestamptz" },
    { expr: "c.created_at", desc: false, nullable: false, cast: "timestamptz" },
  ],
  ratingHigh: [
    { expr: "COALESCE(c.quality_rating, 3)", desc: true, nullable: false, cast: "int" },
    { expr: "c.taken_at", desc: true, nullable: true, cast: "timestamptz" },
  ],
  ratingLow: [
    { expr: "COALESCE(c.quality_rating, 3)", desc: false, nullable: false, cast: "int" },
    { expr: "c.taken_at", desc: true, nullable: true, cast: "timestamptz" },
  ],
};

export function galleryOrderBy(keys: SortKey[]): string {
  return [...keys.map((k) => `${k.expr} ${k.desc ? "DESC" : "ASC"}${k.nullable ? " NULLS LAST" : ""}`), "c.id ASC"].join(", ");
}

interface GalleryCursor {
  sort: string;
  values: Array<string | null>;
  id: string;
}

// base64url JSON of the last row's sort values (as Postgres text, so microseconds survive) and id.
export function encodeGalleryCursor(c: GalleryCursor): string {
  return Buffer.from(JSON.stringify([c.sort, c.values, c.id]), "utf8").toString("base64url");
}

export function decodeGalleryCursor(raw: string): GalleryCursor | null {
  try {
    const [sort, values, id] = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof sort !== "string" || !GALLERY_SORTS[sort] || !Array.isArray(values) || !isUuid(id)) return null;
    if (values.length !== GALLERY_SORTS[sort].length || values.some((v) => v !== null && typeof v !== "string")) return null;
    return { sort, values, id };
  } catch {
    return null;
  }
}

/** "Comes after the cursor row" in the given order, NULLS LAST included. */
export function galleryAfterCursorSql(keys: SortKey[], cursor: GalleryCursor, param: (v: unknown) => string): string {
  const equal: string[] = [];
  const branches: string[] = [];
  keys.forEach((k, i) => {
    const v = cursor.values[i];
    if (v === null) {
      // Past the last non-null value only more nulls follow, so the key can't be "after" here.
      equal.push(`${k.expr} IS NULL`);
      return;
    }
    const p = `${param(v)}::${k.cast}`;
    const after = `${k.expr} ${k.desc ? "<" : ">"} ${p}${k.nullable ? ` OR ${k.expr} IS NULL` : ""}`;
    branches.push(`(${[...equal, `(${after})`].join(" AND ")})`);
    equal.push(`${k.expr} = ${p}`);
  });
  branches.push(`(${[...equal, `c.id > ${param(cursor.id)}::uuid`].join(" AND ")})`);
  return `AND (${branches.join(" OR ")})`;
}

// Search rows cached per user and filter set while a cheap library stamp is unchanged, and for a
// minute at most to catch changes that don't touch a photo row.
const SEARCH_ROWS_TTL_MS = 60_000;
const searchRowsCache = new Map<string, { stamp: string; at: number; rows: SearchRow[] }>();
// These rows hold every photo's vector, so they're dropped once stale.
setInterval(() => {
  const now = Date.now();
  for (const [key, hit] of searchRowsCache) if (now - hit.at >= SEARCH_ROWS_TTL_MS) searchRowsCache.delete(key);
  for (const [key, hit] of vocabCache) if (now - hit.at >= SEARCH_ROWS_TTL_MS) vocabCache.delete(key);
}, 60_000).unref();

// The stamp scans the user's captures, so it's reused for a few seconds per user.
const STAMP_TTL_MS = 3_000;
const stampCache = new Map<string, { stamp: string; at: number }>();

/** Test hook: forget every cached stamp, row set and vocabulary. */
export function clearGallerySearchCaches(): void {
  stampCache.clear();
  searchRowsCache.clear();
  vocabCache.clear();
}

async function libraryStamp(userId: string): Promise<string> {
  const hit = stampCache.get(userId);
  if (hit && Date.now() - hit.at < STAMP_TTL_MS) return hit.stamp;
  const res = await pool.query<{ stamp: string }>(
    `SELECT concat_ws('|', count(*), max(c.updated_at),
              (SELECT max(ce.computed_at) FROM capture_embeddings ce JOIN captures_all c2 ON c2.id = ce.capture_id WHERE c2.user_id = $1),
              (SELECT concat_ws(',', count(*), max(ac.added_at)) FROM album_captures ac JOIN albums a ON a.id = ac.album_id WHERE a.user_id = $1),
              (SELECT concat_ws(',', count(*), max(a.updated_at)) FROM albums a WHERE a.user_id = $1),
              (SELECT count(*) FROM trips t WHERE t.user_id = $1)) AS stamp
       FROM captures_all c WHERE c.user_id = $1`,
    [userId],
  );
  const stamp = res.rows[0]?.stamp ?? "";
  if (stampCache.size > 100) stampCache.delete(stampCache.keys().next().value!);
  stampCache.set(userId, { stamp, at: Date.now() });
  return stamp;
}

async function searchRows(userId: string, stamp: string, sql: string, params: unknown[]): Promise<{ rows: SearchRow[] }> {
  const key = `${userId}|${sql}|${JSON.stringify(params)}`;
  const hit = searchRowsCache.get(key);
  if (hit && hit.stamp === stamp && Date.now() - hit.at < SEARCH_ROWS_TTL_MS) return { rows: hit.rows };
  const res = await pool.query<SearchRow>(sql, params);
  for (const [k, v] of searchRowsCache) if (k.startsWith(`${userId}|`) && v.stamp !== stamp) searchRowsCache.delete(k);
  if (searchRowsCache.size > 50) searchRowsCache.delete(searchRowsCache.keys().next().value!);
  searchRowsCache.set(key, { stamp, at: Date.now(), rows: res.rows });
  return { rows: res.rows };
}

// Places, trips and albums a query can name, and old scientific names for the user's species,
// kept per user while the library stamp holds (and a minute at most, for renames).
const vocabCache = new Map<string, { stamp: string; at: number; places: PlaceEntry[]; synonyms: Map<string, string[]> }>();

async function searchVocabulary(userId: string, stamp: string): Promise<{ places: PlaceEntry[]; synonyms: Map<string, string[]> }> {
  const hit = vocabCache.get(userId);
  if (hit && hit.stamp === stamp && Date.now() - hit.at < SEARCH_ROWS_TTL_MS) return hit;
  const [places, synonymRes] = await Promise.all([
    searchablePlaces(userId),
    pool.query<{ species_id: string; names: string[] }>(
      `SELECT ss.species_id, array_agg(ss.synonym_name) AS names
         FROM species_synonyms ss
        WHERE ss.species_id IN (SELECT DISTINCT species_id FROM captures WHERE user_id = $1)
        GROUP BY ss.species_id`,
      [userId],
    ),
  ]);
  const synonyms = new Map(synonymRes.rows.map((r) => [r.species_id, r.names]));
  if (vocabCache.size > 100) vocabCache.delete(vocabCache.keys().next().value!);
  const entry = { stamp, at: Date.now(), places, synonyms };
  vocabCache.set(userId, entry);
  return entry;
}

// Places a query can name: regions with photos and their ancestors, import location labels, and
// trip and album names. "World" is left out: it contains everything.
async function searchablePlaces(userId: string): Promise<PlaceEntry[]> {
  const res = await pool.query<{ kind: PlaceEntry["kind"]; id: string; name: string }>(
    `WITH RECURSIVE up AS (
       SELECT r.id, r.name, r.parent_id FROM regions r
        WHERE r.id IN (SELECT DISTINCT region_id FROM captures WHERE user_id = $1 AND region_id IS NOT NULL)
       UNION
       SELECT p.id, p.name, p.parent_id FROM regions p JOIN up ON up.parent_id = p.id
     )
     SELECT 'region' AS kind, id::text AS id, name FROM up WHERE parent_id IS NOT NULL
     UNION ALL
     SELECT DISTINCT 'location', location_label, location_label FROM captures
      WHERE user_id = $1 AND location_label IS NOT NULL AND location_label <> ''
     UNION ALL
     SELECT 'trip', id::text, name FROM trips WHERE user_id = $1 AND name IS NOT NULL AND name <> ''
     UNION ALL
     SELECT 'album', id::text, name FROM albums WHERE user_id = $1 AND name IS NOT NULL AND name <> ''`,
    [userId],
  );
  return res.rows;
}

// True once the client has gone away (a newer keystroke cancelled this search).
function watchClientGone(request: FastifyRequest, reply: FastifyReply): () => boolean {
  let gone = false;
  reply.raw.once("close", () => {
    if (!reply.raw.writableFinished) gone = true;
  });
  return () => gone || request.raw.socket?.destroyed === true;
}

// Latin order and family names from the whole catalog, so they filter exactly rather than via CLIP.
// Cached: the catalog changes only on an update.
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

type GalleryQuery = GalleryFilterQuery & { sort?: string; limit?: string; cursor?: string };

export async function galleryRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: GalleryFilterQuery & {
      q?: string;
      /** 1: skip picture matching and answer at once; the page follows up with the full search. */
      quick?: string;
    };
  }>("/gallery/search", { preHandler: requireScope("gallery.read") }, async (request, reply) => {
    const userId = request.user!.id;
    const q = request.query.q?.trim();
    // The same filters as /gallery, so a search never widens past what's already checked.
    const filters = parseGalleryFilters(request.query);
    if ("error" in filters) return reply.code(400).send({ error: filters.error });
    if (!q) return { items: [] };
    const quick = request.query.quick === "1";
    const isGone = watchClientGone(request, reply);

    const params: unknown[] = [userId, EMBEDDING_MODEL_VERSION];
    const param = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const where = galleryFilterSql(filters, param);
    const stamp = await libraryStamp(userId);
    // LEFT JOIN: a photo without a vector is still found by name, group, place and date.
    const [res, vocab, latinGroups] = await Promise.all([
      searchRows(
        userId,
        stamp,
        `SELECT ${GALLERY_ITEM_COLUMNS},
                c.location_label, c.trip_id::text AS trip_id, s.common_name_aliases, s.aba_code, s.ebird_code, s.taxon_order, s.family,
                (SELECT array_agg(ac.album_id::text) FROM album_captures ac WHERE ac.capture_id = c.id) AS album_ids,
                ce.computed_at::text AS embedding_computed_at
           FROM captures c
           ${GALLERY_ITEM_JOINS}
           LEFT JOIN capture_embeddings ce ON ce.capture_id = c.id AND ce.model_version = $2
           WHERE c.user_id = $1
             ${where}`,
        params,
      ),
      searchVocabulary(userId, stamp),
      latinGroupNames(),
    ]);

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
        // Old scientific names (species_synonyms) match the same way an alias does.
        aliases: [...((r.common_name_aliases as string[] | null) ?? []), ...(vocab.synonyms.get(r.species_id) ?? [])],
        codes: [r.aba_code, r.ebird_code].filter((c): c is string => typeof c === "string" && c.length > 0),
      });
    }
    const parsed = parseSearchQuery(q, { species: [...speciesById.values()], places: vocab.places, latinGroups }, { partialWordPicksSpecies: quick });
    // The full pass embeds the description with CLIP; not worth doing for a cancelled request.
    if (!quick && parsed.description && isGone()) return reply.code(499).send();
    const outcome = await rankSearch(q, parsed, res.rows, regionSubtree, { quick });
    return {
      items: outcome.items.map(({ row, score }) => toGalleryItem(row, score)),
      interpretation: outcome.interpretation,
      pending: outcome.pending ?? false,
    };
  });

  app.get<{ Querystring: GalleryQuery }>("/gallery", { preHandler: requireScope("gallery.read") }, async (request, reply) => {
    const userId = request.user!.id;
    const filters = parseGalleryFilters(request.query);
    if ("error" in filters) return reply.code(400).send({ error: filters.error });
    const sortName = request.query.sort && GALLERY_SORTS[request.query.sort] ? request.query.sort : "newest";
    const sortKeys = GALLERY_SORTS[sortName];

    // Optional keyset paging: ?limit= (1-500) returns one page plus nextCursor. Without it, all photos.
    const paged = request.query.limit !== undefined;
    const limit = paged ? parseLimit(request.query.limit, 0, 500) : 0;
    if (paged && limit === 0) return reply.code(400).send({ error: "limit must be a whole number from 1 to 500" });
    let cursor: GalleryCursor | null = null;
    if (request.query.cursor) {
      cursor = decodeGalleryCursor(request.query.cursor);
      if (!cursor || cursor.sort !== sortName) return reply.code(400).send({ error: "Invalid cursor" });
    }

    const params: unknown[] = [userId];
    const param = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const where = galleryFilterSql(filters, param);
    // The filter params only, captured before the cursor adds its own, for the first page's count.
    const filterParams = [...params];
    const after = cursor ? galleryAfterCursorSql(sortKeys, cursor, param) : "";
    // Counted on the first page only.
    const countQuery =
      paged && !cursor
        ? pool.query<{ total: number }>(
            `SELECT count(*)::int AS total
               FROM captures c
               ${GALLERY_ITEM_JOINS}
               WHERE c.user_id = $1
                 ${where}`,
            filterParams,
          )
        : null;
    const [res, countRes] = await Promise.all([
      pool.query(
        `SELECT ${GALLERY_ITEM_COLUMNS}${paged ? `, ${sortKeys.map((k, i) => `(${k.expr})::text AS _sort${i}`).join(", ")}` : ""}
           FROM captures c
           ${GALLERY_ITEM_JOINS}
           WHERE c.user_id = $1
             ${where}
             ${after}
           ORDER BY ${galleryOrderBy(sortKeys)}
           ${paged ? `LIMIT ${limit + 1}` : ""}`,
        params,
      ),
      countQuery,
    ]);

    if (!paged) return { items: res.rows.map((row) => toGalleryItem(row, null)) };
    const page = res.rows.slice(0, limit);
    const last = page.at(-1);
    const nextCursor =
      res.rows.length > limit && last
        ? encodeGalleryCursor({ sort: sortName, values: sortKeys.map((_, i) => last[`_sort${i}`] ?? null), id: last.capture_id })
        : null;
    const total = countRes ? (countRes.rows[0]?.total ?? 0) : undefined;
    return { items: page.map((row) => toGalleryItem(row, null)), nextCursor, ...(total !== undefined ? { total } : {}) };
  });

  // Every capture id the /gallery filters match, so select all needn't page through full items.
  // Video and RAW ids come along for the batch actions that word or offer things by them.
  app.get<{ Querystring: GalleryFilterQuery }>("/gallery/ids", { preHandler: requireScope("gallery.read") }, async (request, reply) => {
    const userId = request.user!.id;
    const filters = parseGalleryFilters(request.query);
    if ("error" in filters) return reply.code(400).send({ error: filters.error });
    const params: unknown[] = [userId];
    const param = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const where = galleryFilterSql(filters, param);
    const res = await pool.query<{ capture_id: string; is_video: boolean; has_raw: boolean }>(
      `SELECT c.id::text AS capture_id, p.kind = 'video' AS is_video,
              EXISTS (SELECT 1 FROM originals ro WHERE ro.capture_id = c.id AND ro.kind = 'raw') AS has_raw
         FROM captures c
         ${GALLERY_ITEM_JOINS}
         WHERE c.user_id = $1
           ${where}`,
      params,
    );
    const captureIds: string[] = [];
    const videoCaptureIds: string[] = [];
    const rawCaptureIds: string[] = [];
    for (const r of res.rows) {
      captureIds.push(r.capture_id);
      if (r.is_video) videoCaptureIds.push(r.capture_id);
      if (r.has_raw) rawCaptureIds.push(r.capture_id);
    }
    return { captureIds, videoCaptureIds, rawCaptureIds };
  });

  // Whether the user has any video, so the "Video" filter only shows when useful.
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

  // Taxon classes the user has photographed, so the Taxon filter never offers empty choices.
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

  // Regions the Region filter offers: those with photos, plus their ancestors so the tree can
  // be drilled down to them.
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

// Response shape for /gallery and /gallery/search; score is null for the plain listing.
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
