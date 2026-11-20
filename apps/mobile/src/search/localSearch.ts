// The desktop's photo search run on the phone's own data: the same query reading and ranking
// (packages/shared), over rows built from the synced captures, with the query embedded on the phone.
// Composition, light, sun position, camera and backgrounds read what the frames feed and the capture
// feed gave the phone, with the region tree and species names the hub's search-vocab feed gave it.
// It has no scene readings, so those stay quiet.
import {
  makePictureScorer,
  type GroupPredicate,
  type LightStats,
  parseSearchQuery,
  rankSearch,
  type PictureScorer,
  type PlaceEntry,
  type SearchRow,
  type SpeciesEntry,
} from "@lifer/shared";
import type { Db } from "../store/db";
import type { GridPhoto } from "../store/library";
import type { SearchPart } from "./searchParts";

interface LocalRow extends SearchRow {
  photo_id: string;
}

interface Raw {
  id: string;
  photo_id: string;
  scientific_name: string;
  taken_at: string | null;
  location_label: string | null;
  tags: string;
  rating: number | null;
  region_id: string | null;
  trip_id: string | null;
  common_name: string | null;
  taxon_class: string | null;
  tier: string | null;
  taxon_order: string | null;
  family: string | null;
  albums: string | null;
  lat: number | null;
  lon: number | null;
  camera_model: string | null;
  focal_length_mm: number | null;
  width: number | null;
  height: number | null;
  box: string | null;
  unsure: number | null;
  aspect: number | null;
  light: string | null;
  zoned: number | null;
}

/** What search sees of the library: every visible photo with its species, tags, place, trip and albums. */
export async function localRows(db: Db): Promise<LocalRow[]> {
  const raw = await db.all<Raw>(
    `SELECT c.id, c.photo_id, c.scientific_name, c.taken_at, c.location_label, c.tags, c.rating, c.region_id, c.trip_id,
            c.lat, c.lon, c.camera_model, c.focal_length_mm, c.width, c.height,
            s.common_name, s.taxon_class, s.taxon_order, s.family, s.tier,
            f.box, f.unsure, f.aspect, f.light, f.zoned,
            (SELECT group_concat(a.album_id) FROM album_captures a WHERE a.capture_id = c.id) AS albums
       FROM captures c LEFT JOIN species s ON s.scientific_name = c.scientific_name
       LEFT JOIN capture_frames f ON f.capture_id = c.id
      WHERE c.photo_id IS NOT NULL AND c.hidden = 0 AND c.kind = 'image'`,
  );
  return raw.map((r) => ({
    photo_id: r.photo_id,
    capture_id: r.id,
    species_id: r.scientific_name,
    quality_rating: r.rating,
    taken_at: r.taken_at,
    tags: JSON.parse(r.tags || "[]") as string[],
    region_id: r.region_id,
    location_label: r.location_label,
    trip_id: r.trip_id,
    album_ids: r.albums ? r.albums.split(",") : null,
    focal_length_mm: r.focal_length_mm,
    embedding_computed_at: null,
    common_name: r.common_name,
    scientific_name: r.scientific_name,
    taxon_class: r.taxon_class,
    taxon_order: r.taxon_order,
    family: r.family,
    tier: r.tier,
    camera_model: r.camera_model,
    lat: r.lat,
    lon: r.lon,
    width: r.width,
    height: r.height,
    // Null until the hub's detector has read the photo (then the photo's own size gives its shape).
    frame_box: r.box ? (JSON.parse(r.box) as number[]) : null,
    frame_unsure: r.unsure === null ? null : !!r.unsure,
    frame_aspect: r.aspect,
    light_stats: r.light ? (JSON.parse(r.light) as LightStats) : null,
    taken_at_zoned: r.zoned === null ? null : !!r.zoned,
  }));
}

/** The names a query can mean: the species in these photos, the regions, trips, albums and place labels. */
async function vocabulary(db: Db, rows: LocalRow[]) {
  const seen = new Map<string, SpeciesEntry>();
  for (const r of rows)
    if (!seen.has(r.species_id))
      seen.set(r.species_id, {
        id: r.species_id,
        commonName: r.common_name,
        scientificName: r.scientific_name,
        taxonClass: r.taxon_class,
        taxonOrder: r.taxon_order,
        family: r.family,
        aliases: [],
        codes: [],
      });
  const [regions, trips, albums, taxa, names, extra] = await Promise.all([
    db.all<{ id: string; name: string; parent_id: string | null }>("SELECT id, name, parent_id FROM search_regions"),
    db.all<{ id: string; name: string }>("SELECT id, name FROM trips"),
    db.all<{ id: string; name: string }>("SELECT id, name FROM albums"),
    db.all<{ kind: "order" | "family"; name: string }>(
      `SELECT DISTINCT 'order' AS kind, lower(taxon_order) AS name FROM species WHERE taxon_order IS NOT NULL
       UNION SELECT DISTINCT 'family', lower(family) FROM species WHERE family IS NOT NULL`,
    ),
    db.all<{ common_name: string }>("SELECT common_name FROM species WHERE common_name IS NOT NULL"),
    db.all<{ scientific_name: string; aliases: string; codes: string }>("SELECT * FROM species_names"),
  ]);
  for (const e of extra) {
    const entry = seen.get(e.scientific_name);
    if (entry) {
      entry.aliases = JSON.parse(e.aliases) as string[];
      entry.codes = JSON.parse(e.codes) as string[];
    }
  }
  const parents = new Map(regions.map((r) => [r.id, r.parent_id]));
  // Latin order and family names ("accipitriformes") and every known animal's main noun, from the
  // species the phone knows (its checklists and photos), as the hub reads them from its catalog.
  const latinGroups = new Map<string, GroupPredicate>(
    taxa.map((t) => [t.name, t.kind === "order" ? { orders: [t.name] } : { families: [t.name] }]),
  );
  const catalogHeads = new Set(names.map((n) => n.common_name.toLowerCase().replace(/^.* /, "")));
  const cameras = [...new Set(rows.map((r) => r.camera_model).filter((m): m is string => !!m))];
  const labels = [...new Set(rows.map((r) => r.location_label).filter((l): l is string => !!l))];
  return {
    parents,
    latinGroups,
    catalogHeads,
    cameras,
    species: [...seen.values()],
    places: [
      ...regions.filter((r) => r.parent_id).map((r): PlaceEntry => ({ kind: "region", id: r.id, name: r.name })),
      ...trips.map((r): PlaceEntry => ({ kind: "trip", ...r })),
      ...albums.map((r): PlaceEntry => ({ kind: "album", ...r })),
      ...labels.map((l): PlaceEntry => ({ kind: "location", id: l, name: l })),
    ],
  };
}

export interface VectorLookup {
  get(id: string): ArrayLike<number> | undefined;
}

/**
 * A picture scorer over the phone's vectors. The lookup hands back one reused array, which the
 * scorer reads at once, so a 60,000 photo library never becomes 60,000 float32 arrays.
 */
export function phoneScorer(
  embedTexts: (texts: string[]) => Promise<Float32Array[]>,
  vectors: () => VectorLookup | Promise<VectorLookup>,
): PictureScorer {
  return makePictureScorer(embedTexts, async () => (await vectors()) as unknown as Map<string, ArrayLike<number>>);
}

/** Wraps a text embedder so a description is embedded once however many scorers ask for it. */
export function cachedEmbedder(
  embedTexts: (texts: string[]) => Promise<Float32Array[]>,
): (texts: string[]) => Promise<Float32Array[]> {
  const seen = new Map<string, Float32Array>();
  return async (texts) => {
    const missing = [...new Set(texts.filter((t) => !seen.has(t)))];
    if (missing.length > 0) {
      const got = await embedTexts(missing);
      missing.forEach((t, i) => seen.set(t, got[i]));
      while (seen.size > 600) seen.delete(seen.keys().next().value!);
    }
    return texts.map((t) => seen.get(t)!);
  };
}

export interface LocalResult {
  photos: GridPhoto[];
  /** What the query was read as, for the tokens above the results. */
  parts: SearchPart[];
}

/** Photos for a typed query, best first, ranked the way the desktop ranks them. */
export async function searchLocal(
  db: Db,
  query: string,
  score: PictureScorer,
  backgroundScore?: PictureScorer,
  now = new Date(),
): Promise<LocalResult> {
  const rows = await localRows(db);
  const vocab = await vocabulary(db, rows);
  const { parents, ...names } = vocab;
  const parsed = parseSearchQuery(query, { ...names, now }, { partialWordPicksSpecies: false });
  // A named region matches itself and every region below it.
  const subtree = async (ids: string[]) => {
    const wanted = new Set(ids);
    const out = new Set(ids);
    for (const id of parents.keys()) {
      for (let at: string | null | undefined = id; at; at = parents.get(at)) if (wanted.has(at)) out.add(id);
    }
    return out;
  };
  const out = await rankSearch(query, parsed, rows, subtree, score, { backgroundScore });
  return {
    photos: out.items.map((i) => ({
      photoId: (i.row as LocalRow).photo_id,
      takenAt: i.row.taken_at ? String(i.row.taken_at) : null,
    })),
    parts: out.interpretation.parts ?? [],
  };
}
