// The opendata.read routes: which regions the user has installed, a region's species list, which
// installed region holds a point, and species ranked for a photo's vector. For companion apps that
// need a regional species list (the same list the user's own phone gets), read with a plugin key.
import type { FastifyInstance, FastifyReply } from "fastify";
import { Type, type Static } from "typebox";
import { pool } from "@lifer/core/db.js";
import { CLIP_SPACE, rankSpeciesBatch } from "@lifer/core/species/embeddings.js";
import { exteriorRingsFromGeometry, ringBoundingBox } from "@lifer/core/lib/geometry.js";
import { EBIRD_SENSITIVE_SPECIES } from "@lifer/core/species/sensitiveSpecies.js";
import { OPEN_VECTOR_LICENSES } from "@lifer/core/species/licensePolicy.js";
import { requireScope } from "../auth/session.js";
import { IdParams, Nullable, Open, Uuid, notFoundOnInvalidId, replies, withSchemas } from "../lib/schema.js";
import { regionAt } from "../regions/regionAt.js";
import { SENSITIVE_IUCN } from "../settings/metadataSettings.js";

const scope = requireScope("opendata.read");

const Bounds = Open({ minLat: Type.Number(), minLon: Type.Number(), maxLat: Type.Number(), maxLon: Type.Number() });
const RegionSummary = Open({
  id: Uuid(),
  name: Type.String(),
  countryCode: Nullable(Type.String({ description: "Two-letter country code, null when unknown" })),
  parentId: Nullable(Uuid({ description: "The region this one is part of, null for a country" })),
  bounds: Nullable(Bounds),
  speciesCount: Type.Integer(),
});
const Checklist = Open({
  regionId: Uuid(),
  name: Type.String(),
  items: Type.Array(
    Open({
      scientificName: Type.String(),
      commonName: Nullable(Type.String()),
      taxonClass: Type.String(),
      ebirdCode: Nullable(Type.String()),
      tier: Nullable(Type.String()),
      isVagrant: Type.Boolean(),
      sensitiveByDefault: Type.Boolean({ description: "Threatened on the IUCN Red List or on eBird's sensitive list" }),
    }),
  ),
});

const SpeciesListDefinitions = Open({
  lists: Type.Array(
    Open({
      id: Uuid(),
      name: Type.String(),
      taxonId: Type.Integer({ description: "iNaturalist taxon id" }),
      taxonName: Type.String(),
      taxonRank: Nullable(Type.String()),
      placeId: Type.Integer({ description: "iNaturalist place id" }),
      placeName: Type.String(),
      nativeOnly: Type.Boolean(),
      sizeEstimate: Nullable(Type.Integer({ description: "iNaturalist's species count when last read" })),
    }),
  ),
});

type Summary = Static<typeof RegionSummary>;

const RegionTree = Open({
  regions: Type.Array(
    Open({
      id: Uuid(),
      name: Type.String(),
      parentId: Nullable(Uuid()),
      countryCode: Nullable(Type.String({ description: "Two-letter country code of the region's country" })),
      aliases: Type.Array(Type.String()),
      hasChildren: Type.Boolean(),
      hasChecklist: Type.Boolean({ description: "Whether GET /regions/:id/checklist has species for it" }),
      installed: Type.Boolean({ description: "Whether it is among GET /regions" }),
    }),
  ),
});

const DIM = 768;
const RankModel = Type.String({
  maxLength: 64,
  description: "The vectors' model version; must be the one Lifer ranks in",
});
const RankRegion = Nullable(Uuid({ description: "Rank within this region's list; null for the user's species" }));
const RankVectors = Type.Array(Type.Array(Type.Number(), { minItems: DIM, maxItems: DIM }), {
  minItems: 1,
  maxItems: 4,
  description: "L2-normalised image vectors of one subject (a crop, and the whole photo when unsure)",
});
const RankTakenAt = Type.Optional(Nullable(Type.String({ format: "date-time" })));
const RankLimit = Type.Optional(Type.Integer({ minimum: 1, maximum: 20 }));
const RankRequest = Type.Object({
  model: RankModel,
  regionId: RankRegion,
  vectors: RankVectors,
  takenAt: RankTakenAt,
  limit: RankLimit,
});
const RankBatchRequest = Type.Object(
  {
    model: RankModel,
    regionId: RankRegion,
    limit: RankLimit,
    items: Type.Array(Type.Object({ vectors: RankVectors, takenAt: RankTakenAt }, { additionalProperties: false }), {
      minItems: 1,
      maxItems: 16,
      description: "One subject per item; results come back in the same order",
    }),
  },
  { additionalProperties: false },
);
const Suggestion = Open({
  scientificName: Type.String(),
  commonName: Nullable(Type.String()),
  score: Type.Number({ description: "Raw blended score; only differences between candidates mean anything" }),
  matchPercent: Nullable(Type.Number()),
  confident: Type.Boolean(),
});
const Ranked = Open({ model: Type.String(), suggestions: Type.Array(Suggestion) });
const RankedBatch = Open({
  model: Type.String(),
  results: Type.Array(Open({ suggestions: Type.Array(Suggestion) })),
});

const NamesRequest = Type.Object({
  scientificNames: Type.Array(Type.String({ maxLength: 200 }), { minItems: 1, maxItems: 2000 }),
});
const Names = Open({
  names: Type.Array(
    Open({
      scientificName: Type.String({ description: "The name asked for" }),
      speciesId: Uuid({ description: "Lifer's id for the species" }),
      gbifKey: Type.Integer({ description: "GBIF backbone taxon key" }),
      canonicalScientificName: Type.String({ description: "Lifer's current scientific name (differs for a synonym)" }),
      commonName: Nullable(Type.String()),
      ebirdCode: Nullable(Type.String()),
      abaCode: Nullable(Type.String()),
    }),
  ),
});

// A region counts as installed when one of its offline packs is downloaded; packs are filed by
// region name, so the region is the same-named row with the most codes (as the phone's list does).
// The provinces of an installed country count too when they have a list of their own.
async function installedRegions(): Promise<Summary[]> {
  const res = await pool.query<{
    id: string;
    name: string;
    parent_id: string | null;
    country_code: string | null;
    species_count: number;
    boundary: { type: string; coordinates: unknown } | null;
  }>(
    `SELECT r.id, r.name, r.species_count, p.parent_id,
            upper(split_part(c.ebird_region_code, '-', 1)) AS country_code,
            CASE WHEN r.boundary_geojson ? 'geometry' THEN r.boundary_geojson -> 'geometry' ELSE r.boundary_geojson END AS boundary
       FROM (
         WITH packed AS (
           SELECT DISTINCT ON (p.region) p.region AS name, r.id, r.home_country_id, r.boundary_geojson,
                  (SELECT sum(species_count) FROM downloaded_packs WHERE region = p.region)::int AS species_count
             FROM downloaded_packs p JOIN regions r ON r.name = p.region
            WHERE p.region IS NOT NULL
            ORDER BY p.region, cardinality(r.external_codes) DESC
         )
         SELECT * FROM packed
         UNION ALL
         SELECT r.name, r.id, r.home_country_id, r.boundary_geojson, n.species_count
           FROM regions r
           CROSS JOIN LATERAL (SELECT count(*)::int AS species_count FROM region_species WHERE region_id = r.id) n
          WHERE r.parent_id IN (SELECT id FROM packed) AND r.id NOT IN (SELECT id FROM packed) AND n.species_count > 0
       ) r
       JOIN regions p ON p.id = r.id
      LEFT JOIN regions c ON c.id = COALESCE(r.home_country_id, r.id)
      ORDER BY r.name`,
  );
  return res.rows.map((r) => {
    const boxes = r.boundary?.type ? exteriorRingsFromGeometry(r.boundary).map(ringBoundingBox) : [];
    return {
      id: r.id,
      name: r.name,
      countryCode: r.country_code || null,
      parentId: r.parent_id,
      bounds: boxes.length
        ? {
            minLat: Math.min(...boxes.map((b) => b.minLat)),
            minLon: Math.min(...boxes.map((b) => b.minLon)),
            maxLat: Math.max(...boxes.map((b) => b.maxLat)),
            maxLon: Math.max(...boxes.map((b) => b.maxLon)),
          }
        : null,
      speciesCount: r.species_count,
    };
  });
}

export async function opendataRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.get(
    "/opendata/v1/regions",
    {
      preValidation: scope,
      schema: { response: replies(Open({ regions: Type.Array(RegionSummary) })) },
    },
    async () => ({ regions: await installedRegions() }),
  );

  app.get(
    "/opendata/v1/regions/at",
    {
      preValidation: scope,
      schema: {
        querystring: Type.Object({
          lat: Type.Number({ minimum: -90, maximum: 90, description: "Latitude in degrees" }),
          lon: Type.Number({ minimum: -180, maximum: 180, description: "Longitude in degrees" }),
        }),
        response: replies(Open({ regions: Type.Array(RegionSummary) })),
      },
    },
    async (request) => {
      const here = await regionAt(request.query.lat, request.query.lon);
      if (!here) return { regions: [] };
      // The region itself, then the ones that contain it, nearest first.
      const chain = await pool.query<{ id: string }>(
        `WITH RECURSIVE up AS (
           SELECT id, parent_id, 0 AS depth FROM regions WHERE id = $1
           UNION ALL SELECT r.id, r.parent_id, up.depth + 1 FROM regions r JOIN up ON r.id = up.parent_id WHERE up.depth < 10
         ) SELECT id FROM up ORDER BY depth`,
        [here.id],
      );
      const installed = new Map((await installedRegions()).map((r) => [r.id, r]));
      return { regions: chain.rows.flatMap((r) => installed.get(r.id) ?? []) };
    },
  );

  // Every region in the catalog, installed or not, for browsing and searching by name or alias.
  app.get(
    "/opendata/v1/regions/tree",
    { preValidation: scope, schema: { response: replies(RegionTree) } },
    async () => {
      const installed = new Set((await installedRegions()).map((r) => r.id));
      const res = await pool.query<{
        id: string;
        name: string;
        parent_id: string | null;
        aliases: string[];
        has_children: boolean;
        has_checklist: boolean;
        country_code: string | null;
      }>(
        // Guantanamo Bay naval base ("USG") is left out, as in GET /regions.
        `SELECT r.id, r.name, r.parent_id, r.aliases, r.has_children,
                EXISTS (SELECT 1 FROM region_species rs WHERE rs.region_id = r.id) AS has_checklist,
                upper(split_part(c.ebird_region_code, '-', 1)) AS country_code
           FROM regions r LEFT JOIN regions c ON c.id = COALESCE(r.home_country_id, r.id)
          WHERE r.external_codes[1] IS DISTINCT FROM 'USG'
          ORDER BY r.parent_id NULLS FIRST, r.name`,
      );
      return {
        regions: res.rows.map((r) => ({
          id: r.id,
          name: r.name,
          parentId: r.parent_id,
          countryCode: r.country_code || null,
          aliases: r.aliases ?? [],
          hasChildren: r.has_children,
          hasChecklist: r.has_checklist,
          installed: installed.has(r.id),
        })),
      };
    },
  );

  // Same items as the phone's checklist (GET /sync/regions/:id/checklist).
  app.get(
    "/opendata/v1/regions/:id/checklist",
    {
      preValidation: scope,
      config: notFoundOnInvalidId("Region not found"),
      schema: { params: IdParams, response: replies(Checklist) },
    },
    async (request, reply) => {
      const region = await pool.query<{ name: string }>(`SELECT name FROM regions WHERE id = $1`, [request.params.id]);
      if (!region.rows[0]) return reply.code(404).send({ error: "Region not found" });
      const res = await pool.query(
        `SELECT s.scientific_name, s.common_name, s.taxon_class, s.ebird_code, rs.is_vagrant,
                COALESCE(o.tier, rs.local_tier, sr.tier) AS tier,
                (COALESCE(st.iucn_status = ANY($3::text[]), false) OR s.scientific_name = ANY($4::text[])) AS sensitive
           FROM region_species rs
           JOIN species s ON s.id = rs.species_id
           LEFT JOIN species_rarity sr ON sr.species_id = s.id
           LEFT JOIN species_traits st ON st.species_id = s.id
           LEFT JOIN user_tier_overrides o ON o.user_id = $2 AND o.species_id = s.id AND o.region_id IS NULL
          WHERE rs.region_id = $1 AND NOT s.is_other_taxa
          ORDER BY s.sort_order NULLS LAST, s.scientific_name`,
        [request.params.id, request.user!.id, SENSITIVE_IUCN, [...EBIRD_SENSITIVE_SPECIES.keys()]],
      );
      return {
        regionId: request.params.id,
        name: region.rows[0].name,
        items: res.rows.map((r) => ({
          scientificName: r.scientific_name,
          commonName: r.common_name,
          taxonClass: r.taxon_class,
          ebirdCode: r.ebird_code,
          tier: r.tier,
          isVagrant: r.is_vagrant,
          sensitiveByDefault: r.sensitive,
        })),
      };
    },
  );
  // The user's lists from iNaturalist as definitions only (taxon, place, size), so an app can build
  // its own equivalent from sources it may use. Never the species, their names or photos.
  app.get(
    "/opendata/v1/species-lists",
    { preValidation: scope, schema: { response: replies(SpeciesListDefinitions) } },
    async (request) => {
      const res = await pool.query<{
        id: string;
        name: string;
        inat_taxon_id: number;
        taxon_name: string;
        taxon_rank: string | null;
        inat_place_id: number;
        place_name: string;
        native_only: boolean;
        size_estimate: number | null;
      }>(
        `SELECT id, name, inat_taxon_id, taxon_name, taxon_rank, inat_place_id, place_name, native_only, size_estimate
           FROM species_lists WHERE user_id = $1 ORDER BY created_at`,
        [request.user!.id],
      );
      return {
        lists: res.rows.map((l) => ({
          id: l.id,
          name: l.name,
          taxonId: l.inat_taxon_id,
          taxonName: l.taxon_name,
          taxonRank: l.taxon_rank,
          placeId: l.inat_place_id,
          placeName: l.place_name,
          nativeOnly: l.native_only,
          sizeEstimate: l.size_estimate,
        })),
      };
    },
  );

  // Lifer's names for the scientific names asked about, resolved through its synonyms. Names are facts, so
  // this takes no user data; names Lifer doesn't know are left out.
  app.post(
    "/opendata/v1/species/names",
    { preValidation: scope, schema: { body: NamesRequest, response: replies(Names) } },
    async (request) => {
      const asked = [...new Set(request.body.scientificNames)];
      const res = await pool.query<{
        asked: string;
        id: string;
        gbif_key: string;
        scientific_name: string;
        common_name: string | null;
        ebird_code: string | null;
        aba_code: string | null;
      }>(
        `SELECT DISTINCT ON (a.asked) a.asked, s.id, s.gbif_key, s.scientific_name, s.common_name, s.ebird_code, s.aba_code
           FROM unnest($1::text[]) AS a(asked)
           JOIN species s ON s.scientific_name = a.asked
             OR s.id = (SELECT syn.species_id FROM species_synonyms syn WHERE syn.synonym_name = a.asked)
          WHERE NOT s.is_other_taxa
          ORDER BY a.asked, (s.scientific_name = a.asked) DESC`,
        [asked],
      );
      return {
        names: res.rows.map((r) => ({
          scientificName: r.asked,
          speciesId: r.id,
          // bigint comes from pg as text; GBIF keys fit a JS number.
          gbifKey: Number(r.gbif_key),
          canonicalScientificName: r.scientific_name,
          commonName: r.common_name,
          ebirdCode: r.ebird_code,
          abaCode: r.aba_code,
        })),
      };
    },
  );

  // Species ranked for a subject's image vectors with Lifer's own matching (reference and gallery
  // photos and names) within a region's list. Open reference photos only, plus the requesting user's own
  // photos of their own species, and no tier or seasonality weighting (not all of it is openly licensed),
  // so the caller weighs abundance itself.
  app.post(
    "/opendata/v1/species/rank",
    { preValidation: scope, schema: { body: RankRequest, response: replies(Ranked) } },
    async (request, reply) => {
      const { model, regionId, vectors, takenAt, limit } = request.body;
      if (model !== CLIP_SPACE.modelVersion) return modelMismatch(reply, model);
      if (!(await suggestEnabled(request.user!.id))) return { model, suggestions: [] };
      const [ranked] = await rankOpen(request.user!.id, regionId, limit, [{ vectors, takenAt }]);
      return { model, suggestions: ranked };
    },
  );

  // The same ranking for many subjects in one request, so an integration ranking a whole import
  // doesn't pay a round trip and candidate load per photo.
  app.post(
    "/opendata/v1/species/rank-batch",
    { preValidation: scope, schema: { body: RankBatchRequest, response: replies(RankedBatch) } },
    async (request, reply) => {
      const { model, regionId, limit, items } = request.body;
      if (model !== CLIP_SPACE.modelVersion) return modelMismatch(reply, model);
      if (!(await suggestEnabled(request.user!.id))) return { model, results: items.map(() => ({ suggestions: [] })) };
      const ranked = await rankOpen(request.user!.id, regionId, limit, items);
      return { model, results: ranked.map((suggestions) => ({ suggestions })) };
    },
  );

  // Gallery vectors whose photos are openly licensed, each with its credit, for apps that match with them.
  app.get(
    "/opendata/v1/gallery-vectors",
    {
      preValidation: scope,
      schema: {
        querystring: Type.Object({
          space: Type.Optional(
            Type.String({
              maxLength: 64,
              description: "The vectors' model version (default: the one Lifer matches in)",
            }),
          ),
          ...OpenPageQuery,
        }),
        response: replies(VectorPage),
      },
    },
    async (request, reply) => {
      const { space } = request.query;
      // The identification model's gallery has no licence tags, so none of it counts as open.
      if (space && space !== CLIP_SPACE.modelVersion)
        return reply.code(409).send({
          error: `Open vectors are in ${CLIP_SPACE.modelVersion}, not ${space}.`,
          code: "model_mismatch",
        });
      const page = await openVectorPage(request.query, true);
      if (!page) return reply.code(400).send({ error: "Invalid cursor" });
      return {
        model: CLIP_SPACE.modelVersion,
        dimension: DIM,
        ...(page as Omit<Static<typeof VectorPage>, "model" | "dimension">),
      };
    },
  );

  // The same vectors' credits without the vectors: photographer, licence and source of each.
  app.get(
    "/opendata/v1/attribution",
    { preValidation: scope, schema: { querystring: Type.Object(OpenPageQuery), response: replies(AttributionPage) } },
    async (request, reply) =>
      (await openVectorPage(request.query, false)) ?? reply.code(400).send({ error: "Invalid cursor" }),
  );
}

const OpenPageQuery = {
  since: Type.Optional(
    Type.String({
      format: "date-time",
      description: "Only vectors added after this time (an `updatedAt` from an earlier call)",
    }),
  ),
  cursor: Type.Optional(Type.String({ maxLength: 200, description: "`nextCursor` from the previous page" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Page size, 1-500 (default 100)" })),
};
const Credit = {
  speciesId: Uuid(),
  scientificName: Type.String(),
  photoUrl: Type.String({ description: "The photo the vector was computed from" }),
  license: Type.String({ description: "CC0, Public Domain Mark (pd) or CC BY, as stored (may carry a version)" }),
  photographer: Type.String(),
  sourceUrl: Type.String({ description: "The photo's page, or the photo itself when its page isn't known" }),
  updatedAt: Type.String({ format: "date-time" }),
};
const AttributionPage = Open({ items: Type.Array(Open(Credit)), nextCursor: Nullable(Type.String()) });
const VectorPage = Open({
  model: Type.String(),
  dimension: Type.Integer(),
  items: Type.Array(Open({ ...Credit, embedding: Type.Array(Type.Number(), { description: "L2-normalised" }) })),
  nextCursor: Nullable(Type.String()),
});

const VECTOR_TS = `to_char(ge.computed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const encodeVectorCursor = (time: string, id: string) => Buffer.from(`${time}|${id}`).toString("base64url");
function decodeVectorCursor(cursor: string): { time: string; id: string } | null {
  const [time, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  // Exactly the shape VECTOR_TS writes, so a forged cursor can't reach Postgres as a bad value.
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(time ?? "") || !/^[0-9a-f-]{36}$/.test(id ?? "")) return null;
  return { time, id };
}

// A whitelist: only vectors tagged with a licence in OPEN_VECTOR_LICENSES; untagged ones never pass.
// shortcut: sorts the whole open subset per page with no index on computed_at; add one if pages get slow.
async function openVectorPage(query: { since?: string; cursor?: string; limit?: number }, withVectors: boolean) {
  const limit = Math.min(query.limit ?? 100, 500);
  const params: unknown[] = [CLIP_SPACE.modelVersion, [...OPEN_VECTOR_LICENSES]];
  const where: string[] = [];
  if (query.since) {
    params.push(query.since);
    where.push(`ge.computed_at > $${params.length}::timestamptz`);
  }
  if (query.cursor) {
    const cursor = decodeVectorCursor(query.cursor);
    if (!cursor) return null;
    params.push(cursor.time, cursor.id);
    where.push(
      `(ge.computed_at, ge.reference_photo_id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
    );
  }
  params.push(limit + 1);
  const res = await pool.query(
    // The licence is normalised as licensePolicy's normalizeLicense does (lower case, no version).
    `SELECT ge.reference_photo_id AS id, ge.species_id, s.scientific_name, p.photo_url, ge.license,
            COALESCE(ge.photographer, p.credit) AS photographer, COALESCE(ge.source_url, p.photo_url) AS source_url,
            ${VECTOR_TS} AS ts${withVectors ? ", ge.embedding" : ""}
       FROM species_reference_gallery_embeddings ge
       JOIN species_reference_photos p ON p.id = ge.reference_photo_id
       JOIN species s ON s.id = ge.species_id
      WHERE ge.model_version = $1
        -- Species added from iNaturalist by hand or in a list never leave Lifer.
        AND NOT s.is_other_taxa
        AND regexp_replace(lower(ge.license), '-\\d+(\\.\\d+)*$', '') = ANY($2::text[])
        ${where.map((w) => `AND ${w}`).join(" ")}
      ORDER BY ge.computed_at, ge.reference_photo_id
      LIMIT $${params.length}`,
    params,
  );
  const rows = res.rows.slice(0, limit);
  const last = rows[rows.length - 1];
  return {
    items: rows.map((r) => ({
      speciesId: r.species_id,
      scientificName: r.scientific_name,
      photoUrl: r.photo_url,
      license: r.license,
      photographer: r.photographer,
      sourceUrl: r.source_url,
      updatedAt: r.ts,
      ...(withVectors ? { embedding: r.embedding } : {}),
    })),
    nextCursor: res.rows.length > limit && last ? encodeVectorCursor(last.ts, last.id) : null,
  };
}

function modelMismatch(reply: FastifyReply, model: string) {
  return reply
    .code(409)
    .send({ error: `Lifer ranks ${CLIP_SPACE.modelVersion} vectors, not ${model}.`, code: "model_mismatch" });
}

async function suggestEnabled(userId: string): Promise<boolean> {
  const res = await pool.query<{ species_suggest_enabled: boolean }>(
    `SELECT species_suggest_enabled FROM users WHERE id = $1`,
    [userId],
  );
  return res.rows[0]?.species_suggest_enabled !== false;
}

async function rankOpen(
  userId: string,
  regionId: string | null,
  limit: number | undefined,
  items: { vectors: number[][]; takenAt?: string | null }[],
): Promise<Static<typeof Suggestion>[][]> {
  const ranked = await rankSpeciesBatch(
    pool,
    userId,
    items.map((i) => ({
      embeddings: i.vectors.map((v) => Float32Array.from(v)),
      takenAt: i.takenAt ? new Date(i.takenAt) : null,
    })),
    regionId,
    limit ?? 10,
    CLIP_SPACE,
    null,
    { openOnly: true },
  );
  return ranked.map((list) =>
    list.map((s) => ({
      scientificName: s.scientific_name,
      commonName: s.common_name,
      score: s.score,
      matchPercent: s.matchPercent ?? null,
      confident: s.confident ?? false,
    })),
  );
}
