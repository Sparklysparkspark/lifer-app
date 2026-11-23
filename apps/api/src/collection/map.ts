// The Collection map's species pins: where in a region you photographed each species, one pin per
// species per ~1 km grid cell. Only photos with coordinates count. A pin shows where its cell's
// position is inside the region's outline or within NEAR_KM of it (the territorial sea), or where
// one of its photos is filed under the region or below it, wherever that was taken. World and
// continents have no outline: what's filed under them shows.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { Nullable, Open, Uuid, replies, withSchemas } from "../lib/schema.js";
import { requireAuth } from "../auth/session.js";
import { NOT_ARCHIVED_SQL } from "../species/obscurity.js";
import { GALLERY_ITEM_COLUMNS, GALLERY_ITEM_FRAME_JOINS, toGalleryItem, type GalleryRow } from "../gallery/routes.js";
import { GalleryItem } from "../gallery/responses.js";
import { NEAR_KM, nearOutline, parseOutline, prefilterBoxes, type Outline } from "./pinOutline.js";

/** Most photos one pin's preview opens. */
export const PIN_PHOTO_CAP = 200;

/** Most pins sent, the ones with the most photos first. */
export const PIN_CAP = 2000;
// Most cells read from the outline's box before the outline test, so a huge box stays bounded.
const CELL_READ_CAP = 50_000;
// 2 decimals is about 1 km: repeat visits to one spot share a pin.
const PRECISION = 2;

const SpeciesPin = Open({
  speciesId: Uuid(),
  commonName: Nullable(Type.String()),
  scientificName: Type.String(),
  taxonClass: Nullable(Type.String()),
  iconicTaxon: Nullable(Type.String({ description: "iNaturalist iconic taxon, for other taxa" })),
  lat: Type.Number({ description: "Mean position of the photos in the cell" }),
  lon: Type.Number(),
  count: Type.Integer({ description: "Photos of the species in the cell" }),
  photoId: Uuid({ description: "The cell's best photo: best rated, then newest" }),
});

const CollectionMap = Open({
  pins: Type.Array(SpeciesPin),
  truncated: Type.Boolean({ description: "More pins than the cap; the smallest were left out" }),
});

// The region ($2) and everything filed under it.
const REGION_TREE = `tree AS (
    SELECT id FROM regions WHERE id = $2::uuid
    UNION
    SELECT r.id FROM regions r JOIN tree t ON r.parent_id = t.id
  )`;
const FILED = `c.region_id IN (SELECT id FROM tree)`;

/** Which photos a region's pins are read from: filed under it, or with an outline (boxes is its
 *  parameter, the prefilter boxes as JSON) also inside the outline's box grown by NEAR_KM. */
const where = (boxes: string | null) =>
  boxes
    ? `(${FILED} OR EXISTS (SELECT 1 FROM jsonb_to_recordset(${boxes}::jsonb) b(w float8, s float8, e float8, n float8)
         WHERE c.lat BETWEEN b.s AND b.n AND c.lon BETWEEN b.w AND b.e))`
    : FILED;

// Captures of the species itself or one it also features. $3 is the boxes with an outline.
export const collectionMapSql = (hasOutline: boolean) => `WITH RECURSIVE ${REGION_TREE},
  shots AS (
    SELECT c.id, c.species_id, c.lat, c.lon, c.quality_rating, c.taken_at, c.current_photo_id, ${FILED} AS filed
    FROM captures c
    WHERE c.user_id = $1 AND ${where(hasOutline ? "$3" : null)}
      AND c.lat IS NOT NULL AND c.lon IS NOT NULL AND c.current_photo_id IS NOT NULL
  ),
  tagged AS (
    SELECT species_id, lat, lon, quality_rating, taken_at, current_photo_id, filed FROM shots WHERE species_id IS NOT NULL
    UNION ALL
    SELECT cs.species_id, sh.lat, sh.lon, sh.quality_rating, sh.taken_at, sh.current_photo_id, sh.filed
    FROM shots sh JOIN capture_species cs ON cs.capture_id = sh.id
    WHERE cs.species_id IS DISTINCT FROM sh.species_id
  ),
  cells AS (
    SELECT tg.species_id, round(tg.lat, ${PRECISION}) AS glat, round(tg.lon, ${PRECISION}) AS glon,
           avg(tg.lat)::float8 AS lat, avg(tg.lon)::float8 AS lon, count(*)::int AS n, bool_or(tg.filed) AS filed,
           (array_agg(tg.current_photo_id::text ORDER BY tg.quality_rating DESC NULLS LAST, tg.taken_at DESC NULLS LAST))[1] AS photo_id
    FROM tagged tg
    LEFT JOIN user_species us ON us.user_id = $1 AND us.species_id = tg.species_id
    LEFT JOIN user_archived_species uas ON uas.user_id = $1 AND uas.species_id = tg.species_id
    WHERE ${NOT_ARCHIVED_SQL}
    GROUP BY 1, 2, 3
  )
  SELECT cells.species_id, cells.lat, cells.lon, cells.n, cells.photo_id, cells.filed,
         s.common_name, s.scientific_name, s.taxon_class, s.inat_iconic_taxon
  FROM cells JOIN species s ON s.id = cells.species_id
  ORDER BY cells.n DESC, cells.species_id, cells.glat, cells.glon
  LIMIT ${hasOutline ? CELL_READ_CAP + 1 : PIN_CAP + 1}`;

// Outlines only change with a catalog update, which keeps region ids: parsed once per process.
const outlines = new Map<string, Promise<Outline | null>>();
export function outlineOf(regionId: string): Promise<Outline | null> {
  let found = outlines.get(regionId);
  if (!found) {
    found = pool
      .query<{ boundary_geojson: unknown }>(`SELECT boundary_geojson FROM regions WHERE id = $1`, [regionId])
      .then((res) => parseOutline(res.rows[0]?.boundary_geojson));
    found.catch(() => outlines.delete(regionId));
    outlines.set(regionId, found);
  }
  return found;
}
/** The region's outline and, with one, its prefilter boxes' JSON for the queries. */
async function regionRule(regionId: string) {
  const outline = await outlineOf(regionId);
  return { outline, boxes: outline ? [JSON.stringify(prefilterBoxes(outline, NEAR_KM))] : [] };
}

interface PinRow {
  species_id: string;
  lat: number;
  lon: number;
  n: number;
  photo_id: string;
  filed: boolean;
  common_name: string | null;
  scientific_name: string;
  taxon_class: string | null;
  inat_iconic_taxon: string | null;
}

export async function collectionMapRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  await app.register(collectionMapPhotoRoutes);
  app.get(
    "/collection/map",
    {
      preValidation: requireAuth,
      schema: {
        querystring: Type.Object({ regionId: Uuid({ description: "The region whose pins to show" }) }),
        response: replies(CollectionMap),
      },
    },
    async (request) => {
      const { regionId } = request.query;
      const { outline, boxes } = await regionRule(regionId);
      const res = await pool.query<PinRow>(collectionMapSql(!!outline), [request.user!.id, regionId, ...boxes]);
      // shortcut: a cell is kept or dropped by its pin's position, so a 1 km cell on the edge
      // keeps the few photos just past it; test each photo if edges ever look wrong.
      const inside = outline ? res.rows.filter((r) => r.filed || nearOutline(outline, r.lon, r.lat)) : res.rows;
      const rows = inside.slice(0, PIN_CAP);
      return {
        pins: rows.map((r) => ({
          speciesId: r.species_id,
          commonName: r.common_name,
          scientificName: r.scientific_name,
          taxonClass: r.taxon_class,
          iconicTaxon: r.inat_iconic_taxon,
          lat: r.lat,
          lon: r.lon,
          count: r.n,
          photoId: r.photo_id,
        })),
        truncated: inside.length > PIN_CAP || (!!outline && res.rows.length > CELL_READ_CAP),
      };
    },
  );
}

// One pin's photos, best first, by the same rule as its pin. A pin sits at the mean of its cell's
// photos, which rounds back to the same cell; cell_filed is whether any of them is filed under the
// region, counted before the limit like the pin's. $6 is the boxes with an outline.
export const pinPhotosSql = (hasOutline: boolean) => `WITH RECURSIVE ${REGION_TREE}
  SELECT ${GALLERY_ITEM_COLUMNS}, bool_or(${FILED}) OVER () AS cell_filed
  FROM captures c ${GALLERY_ITEM_FRAME_JOINS}
  WHERE c.user_id = $1 AND ${where(hasOutline ? "$6" : null)}
    AND (c.species_id = $3 OR EXISTS (SELECT 1 FROM capture_species cs WHERE cs.capture_id = c.id AND cs.species_id = $3))
    AND round(c.lat, ${PRECISION}) = round($4::numeric, ${PRECISION})
    AND round(c.lon, ${PRECISION}) = round($5::numeric, ${PRECISION})
  ORDER BY c.quality_rating DESC NULLS LAST, c.taken_at DESC NULLS LAST, c.id
  LIMIT ${PIN_PHOTO_CAP}`;

export async function collectionMapPhotoRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  app.get(
    "/collection/map/photos",
    {
      preValidation: requireAuth,
      schema: {
        querystring: Type.Object({
          regionId: Uuid({ description: "The region the pin is in" }),
          speciesId: Uuid(),
          lat: Type.Number({
            minimum: -90,
            maximum: 90,
            description: "The pin's position, as /collection/map sent it",
          }),
          lon: Type.Number({ minimum: -180, maximum: 180 }),
        }),
        response: replies(Open({ items: Type.Array(GalleryItem) })),
      },
    },
    async (request) => {
      const { regionId, speciesId, lat, lon } = request.query;
      const { outline, boxes } = await regionRule(regionId);
      const res = await pool.query<GalleryRow & { cell_filed: boolean }>(pinPhotosSql(!!outline), [
        request.user!.id,
        regionId,
        speciesId,
        lat,
        lon,
        ...boxes,
      ]);
      // A point away from the outline is a pin of this region only through a photo filed under it.
      if (outline && !res.rows[0]?.cell_filed && !nearOutline(outline, lon, lat)) return { items: [] };
      return { items: res.rows.map((r) => toGalleryItem(r, null)) };
    },
  );
}
