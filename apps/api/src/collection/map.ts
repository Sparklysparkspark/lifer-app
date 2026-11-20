// The Collection map's species pins: where in a region you photographed each species, one pin per
// species per ~1 km grid cell. Only photos with coordinates count, and a pin follows where they
// were taken: the cells whose position is inside the region's outline, whatever region the photos
// are filed under.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { Nullable, Open, Uuid, replies, withSchemas } from "../lib/schema.js";
import { requireAuth } from "../auth/session.js";
import { NOT_ARCHIVED_SQL } from "../species/obscurity.js";
import { GALLERY_ITEM_COLUMNS, GALLERY_ITEM_FRAME_JOINS, toGalleryItem, type GalleryRow } from "../gallery/routes.js";
import { GalleryItem } from "../gallery/responses.js";
import { inOutline, parseOutline, prefilterBoxes, type Outline } from "./pinOutline.js";

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

// The region and everything filed under it. Only for a region with no outline: with one, $2 is the
// outline's JSON, and a parameter can't be a uuid here and jsonb there.
const REGION_TREE = `tree AS (
    SELECT id FROM regions WHERE id = $2::uuid
    UNION
    SELECT r.id FROM regions r JOIN tree t ON r.parent_id = t.id
  )`;

/** Where a photo must be for a region's pins: $2 is the outline's prefilter boxes (JSON), or with
 *  no outline (world, continents) the region id, and then its subtree decides. */
const where = (hasOutline: boolean) =>
  hasOutline
    ? `EXISTS (SELECT 1 FROM jsonb_to_recordset($2::jsonb) b(w float8, s float8, e float8, n float8)
         WHERE c.lat BETWEEN b.s AND b.n AND c.lon BETWEEN b.w AND b.e)`
    : `c.region_id IN (SELECT id FROM tree)`;

// Captures of the species itself or one it also features.
export const collectionMapSql = (hasOutline: boolean) => `WITH ${hasOutline ? "" : `RECURSIVE ${REGION_TREE},`}
  shots AS (
    SELECT c.id, c.species_id, c.lat, c.lon, c.quality_rating, c.taken_at, c.current_photo_id
    FROM captures c
    WHERE c.user_id = $1 AND ${where(hasOutline)}
      AND c.lat IS NOT NULL AND c.lon IS NOT NULL AND c.current_photo_id IS NOT NULL
  ),
  tagged AS (
    SELECT species_id, lat, lon, quality_rating, taken_at, current_photo_id FROM shots WHERE species_id IS NOT NULL
    UNION ALL
    SELECT cs.species_id, sh.lat, sh.lon, sh.quality_rating, sh.taken_at, sh.current_photo_id
    FROM shots sh JOIN capture_species cs ON cs.capture_id = sh.id
    WHERE cs.species_id IS DISTINCT FROM sh.species_id
  ),
  cells AS (
    SELECT tg.species_id, round(tg.lat, ${PRECISION}) AS glat, round(tg.lon, ${PRECISION}) AS glon,
           avg(tg.lat)::float8 AS lat, avg(tg.lon)::float8 AS lon, count(*)::int AS n,
           (array_agg(tg.current_photo_id::text ORDER BY tg.quality_rating DESC NULLS LAST, tg.taken_at DESC NULLS LAST))[1] AS photo_id
    FROM tagged tg
    LEFT JOIN user_species us ON us.user_id = $1 AND us.species_id = tg.species_id
    LEFT JOIN user_archived_species uas ON uas.user_id = $1 AND uas.species_id = tg.species_id
    WHERE ${NOT_ARCHIVED_SQL}
    GROUP BY 1, 2, 3
  )
  SELECT cells.species_id, cells.lat, cells.lon, cells.n, cells.photo_id,
         s.common_name, s.scientific_name, s.taxon_class, s.inat_iconic_taxon
  FROM cells JOIN species s ON s.id = cells.species_id
  ORDER BY cells.n DESC, cells.species_id, cells.glat, cells.glon
  LIMIT ${hasOutline ? CELL_READ_CAP + 1 : PIN_CAP + 1}`;

// Outlines only change with a catalog update, which keeps region ids: parsed once per process.
const outlines = new Map<string, Promise<Outline | null>>();
function outlineOf(regionId: string): Promise<Outline | null> {
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
/** The region's outline and what $2 is in the queries for it. */
async function regionRule(regionId: string) {
  const outline = await outlineOf(regionId);
  return { outline, param: outline ? JSON.stringify(prefilterBoxes(outline)) : regionId };
}

interface PinRow {
  species_id: string;
  lat: number;
  lon: number;
  n: number;
  photo_id: string;
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
      const { outline, param } = await regionRule(request.query.regionId);
      const res = await pool.query<PinRow>(collectionMapSql(!!outline), [request.user!.id, param]);
      // shortcut: a cell is kept or dropped by its pin's position, so a 1 km cell on the border
      // keeps the few photos just outside it; test each photo if borders ever look wrong.
      const inside = outline ? res.rows.filter((r) => inOutline(outline, r.lon, r.lat)) : res.rows;
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
// photos, which rounds back to the same cell.
export const pinPhotosSql = (hasOutline: boolean) => `${hasOutline ? "" : `WITH RECURSIVE ${REGION_TREE}`}
  SELECT ${GALLERY_ITEM_COLUMNS}
  FROM captures c ${GALLERY_ITEM_FRAME_JOINS}
  WHERE c.user_id = $1 AND ${where(hasOutline)}
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
      const { outline, param } = await regionRule(regionId);
      // A point outside the outline is no pin of this region.
      if (outline && !inOutline(outline, lon, lat)) return { items: [] };
      const res = await pool.query<GalleryRow>(pinPhotosSql(!!outline), [request.user!.id, param, speciesId, lat, lon]);
      return { items: res.rows.map((r) => toGalleryItem(r, null)) };
    },
  );
}
