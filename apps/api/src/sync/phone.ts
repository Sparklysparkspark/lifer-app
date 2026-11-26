// What a paired phone reads beyond the change feeds (sync/changes.ts, sync/library.ts): the
// settings that change what it shows, a region's checklist, and version-checked species marks.
// Every route takes the "sync" scope or a device key ("companion").
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool, withTransaction } from "@lifer/core/db.js";
import { packRegionIdSql } from "@lifer/core/regions/regionTree.js";
import { EBIRD_SENSITIVE_SPECIES } from "@lifer/core/species/sensitiveSpecies.js";
import { requireScope } from "../auth/session.js";
import { IdParams, Nullable, Open, notFoundOnInvalidId, replies, Uuid, withSchemas } from "../lib/schema.js";
import { getSpeciesNameDisplay } from "../settings/speciesNameDisplay.js";
import { getSensitiveSettings, SENSITIVE_IUCN } from "../settings/metadataSettings.js";
import { listUserSpeciesByName, UserSpeciesSchema, type PushedUserSpecies } from "./changes.js";
import { applyPushedUserSpecies } from "./pushServer.js";

const scope = requireScope("sync", ["companion"]);

const Preferences = Open({
  nameDisplay: Nullable(Open({ main: Type.String(), also: Type.Array(Type.String()) })),
  namingStyles: Type.Array(Type.String()),
  sensitive: Open({
    enabled: Type.Boolean(),
    added: Type.Array(Type.String({ description: "Scientific names the user marked sensitive" })),
    removed: Type.Array(Type.String({ description: "Scientific names the user treats as ordinary" })),
    iucnStatuses: Type.Array(Type.String({ description: "IUCN statuses that are sensitive by default" })),
  }),
  geoprivacy: Open({
    spotDefault: Type.String({
      description: "Used for a saved spot with none chosen; each spot's own is in /sync/saved-spots",
    }),
  }),
  regions: Type.Array(
    Open({
      regionId: Nullable(Uuid()),
      name: Type.String(),
      packIds: Type.Array(Type.String()),
      speciesCount: Type.Integer(),
    }),
  ),
});

// The regions that have a species list on this hub and every ancestor, with how deep each sits
// (World 0, continent 1, country 2, then a country's groups and provinces) and its own species count.
// The phone's region picker walks it as country > group > province.
const RegionTree = Open({
  regions: Type.Array(
    Open({
      id: Uuid(),
      name: Type.String(),
      parentId: Nullable(Uuid()),
      depth: Type.Integer(),
      speciesCount: Type.Integer(),
    }),
  ),
});

const Checklist = Open({
  regionId: Uuid(),
  name: Type.String(),
  items: Type.Array(
    Open({
      scientificName: Type.String(),
      commonName: Nullable(Type.String()),
      taxonClass: Type.String(),
      taxonOrder: Nullable(Type.String()),
      family: Nullable(Type.String()),
      sortOrder: Type.Optional(
        Nullable(Type.Integer({ description: "The species' place in field guide order within its family" })),
      ),
      ebirdCode: Nullable(Type.String()),
      tier: Nullable(
        Type.String({ description: "The user's tier, else this region's, else worldwide: kept for older phones" }),
      ),
      localTier: Nullable(Type.String({ description: "The user's tier, else this region's own" })),
      worldTier: Nullable(Type.String({ description: "The user's tier, else the worldwide one" })),
      localTierReason: Nullable(Type.String({ description: "Why this region's tier is missing or how it was set" })),
      tierReason: Nullable(Type.String({ description: "Why the worldwide tier is missing or how it was set" })),
      isVagrant: Type.Boolean(),
      sensitiveByDefault: Type.Boolean({ description: "Threatened on the IUCN Red List or on eBird's sensitive list" }),
    }),
  ),
});

// What the phone's offline search needs beyond names: the region tree over its photos, and the
// order, family, aliases and codes of the species it has photos of (as the desktop search reads them).
const SearchVocab = Open({
  regions: Type.Array(
    Open({
      id: Uuid(),
      name: Type.String(),
      parentId: Nullable(Uuid()),
      homeCountryId: Type.Optional(
        Nullable(Uuid({ description: "A province listed under a continent still belongs to this country" })),
      ),
    }),
  ),
  species: Type.Array(
    Open({
      scientificName: Type.String(),
      taxonOrder: Nullable(Type.String()),
      family: Nullable(Type.String()),
      aliases: Type.Array(Type.String({ description: "Other common names and old scientific names" })),
      codes: Type.Array(Type.String()),
    }),
  ),
});

// A mark the phone sends, with the version of the hub's copy it last saw (null: never saw one).
const PushedMark = Type.Object({
  ...UserSpeciesSchema.properties,
  baseUpdatedAt: Nullable(Type.String({ format: "date-time" })),
});
const MarksReply = Type.Object({
  applied: Type.Record(Type.String(), Type.String(), { description: "Scientific name to the mark's new version" }),
  conflicts: Type.Array(UserSpeciesSchema, {
    description: "The hub's copy of each mark that changed since the one sent",
  }),
});

export async function phoneSyncRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.get(
    "/sync/preferences",
    { preValidation: scope, schema: { response: replies(Preferences) } },
    async (request) => {
      const userId = request.user!.id;
      const sensitive = await getSensitiveSettings(userId);
      const [styles, regions] = await Promise.all([
        pool.query<{ s: string[] }>(`SELECT species_naming_styles AS s FROM users WHERE id = $1`, [userId]),
        pool.query(
          `SELECT p.region AS name, array_agg(p.pack_id ORDER BY p.pack_id) AS pack_ids, sum(p.species_count)::int AS species_count,
                (${packRegionIdSql("p.region")}) AS region_id
           FROM downloaded_packs p WHERE p.region IS NOT NULL GROUP BY p.region ORDER BY p.region`,
        ),
      ]);
      const byId = new Map(
        (
          await pool.query<{ id: string; scientific_name: string }>(
            `SELECT id, scientific_name FROM species WHERE id = ANY($1::uuid[])`,
            [[...sensitive.added, ...sensitive.removed].filter((id) => /^[0-9a-f-]{36}$/i.test(id))],
          )
        ).rows.map((r) => [r.id, r.scientific_name]),
      );
      const toNames = (ids: string[]) => ids.map((id) => byId.get(id)).filter((n): n is string => !!n);
      return {
        nameDisplay: await getSpeciesNameDisplay(userId),
        namingStyles: styles.rows[0]?.s ?? [],
        sensitive: {
          enabled: sensitive.enabled,
          added: toNames(sensitive.added),
          removed: toNames(sensitive.removed),
          iucnStatuses: SENSITIVE_IUCN,
        },
        geoprivacy: { spotDefault: "open" },
        regions: regions.rows.map((r) => ({
          regionId: r.region_id ?? null,
          name: r.name,
          packIds: r.pack_ids,
          speciesCount: r.species_count,
        })),
      };
    },
  );

  app.get(
    "/sync/search-vocab",
    { preValidation: scope, schema: { response: replies(SearchVocab) } },
    async (request) => {
      const userId = request.user!.id;
      const [regions, species] = await Promise.all([
        // The regions photos sit in and every ancestor, so a named region reaches its sub-regions.
        pool.query<{ id: string; name: string; parent_id: string | null; home_country_id: string | null }>(
          `WITH RECURSIVE up AS (
             SELECT r.id, r.name, r.parent_id, r.home_country_id FROM regions r
              WHERE r.id IN (SELECT DISTINCT region_id FROM captures WHERE user_id = $1 AND region_id IS NOT NULL)
             UNION
             SELECT p.id, p.name, p.parent_id, p.home_country_id FROM regions p
               JOIN up ON p.id = up.parent_id OR p.id = up.home_country_id
           )
           SELECT id::text AS id, name, parent_id::text AS parent_id, home_country_id::text AS home_country_id
             FROM up ORDER BY name, id`,
          [userId],
        ),
        pool.query(
          `SELECT s.scientific_name, s.taxon_order, s.family, s.common_name_aliases, s.aba_code, s.ebird_code,
                  COALESCE((SELECT array_agg(ss.synonym_name) FROM species_synonyms ss WHERE ss.species_id = s.id), '{}') AS synonyms
             FROM species s WHERE s.id IN (SELECT DISTINCT species_id FROM captures WHERE user_id = $1)
            ORDER BY s.scientific_name`,
          [userId],
        ),
      ]);
      return {
        regions: regions.rows.map((r) => ({
          id: r.id,
          name: r.name,
          parentId: r.parent_id,
          homeCountryId: r.home_country_id,
        })),
        species: species.rows.map((r) => ({
          scientificName: r.scientific_name,
          taxonOrder: r.taxon_order,
          family: r.family,
          aliases: [...(r.common_name_aliases ?? []), ...r.synonyms],
          codes: [r.aba_code, r.ebird_code].filter((c): c is string => typeof c === "string" && c.length > 0),
        })),
      };
    },
  );

  app.get("/sync/region-tree", { preValidation: scope, schema: { response: replies(RegionTree) } }, async () => {
    const res = await pool.query<{ id: string; name: string; parent_id: string | null; depth: number; n: number }>(
      `WITH RECURSIVE counted AS (
           SELECT region_id AS id, count(*)::int AS n FROM region_species GROUP BY region_id
         ), up AS (
           SELECT r.id, r.name, r.parent_id, c.n FROM regions r JOIN counted c ON c.id = r.id
           UNION
           SELECT p.id, p.name, p.parent_id, 0 FROM regions p JOIN up ON up.parent_id = p.id
         ), kept AS (
           SELECT id, name, parent_id, max(n) AS n FROM up GROUP BY id, name, parent_id
         ), depth AS (
           SELECT id, 0 AS depth FROM regions WHERE parent_id IS NULL
           UNION ALL
           SELECT r.id, d.depth + 1 FROM regions r JOIN depth d ON r.parent_id = d.id
         )
         SELECT k.id::text AS id, k.name, k.parent_id::text AS parent_id, d.depth, k.n
           FROM kept k JOIN depth d ON d.id = k.id ORDER BY k.name, k.id`,
    );
    return {
      regions: res.rows.map((r) => ({
        id: r.id,
        name: r.name,
        parentId: r.parent_id,
        depth: r.depth,
        speciesCount: r.n,
      })),
    };
  });

  app.get(
    "/sync/regions/:id/checklist",
    {
      preValidation: scope,
      config: notFoundOnInvalidId("Region not found"),
      schema: { params: IdParams, response: replies(Checklist) },
    },
    async (request, reply) => {
      const region = await pool.query<{ name: string }>(`SELECT name FROM regions WHERE id = $1`, [request.params.id]);
      if (!region.rows[0]) return reply.code(404).send({ error: "Region not found" });
      const res = await pool.query(
        `SELECT s.scientific_name, s.common_name, s.taxon_class, s.taxon_order, s.family, s.sort_order, s.ebird_code, rs.is_vagrant,
                COALESCE(o.tier, rs.local_tier, sr.tier) AS tier, COALESCE(o.tier, rs.local_tier) AS local_tier,
                COALESCE(o.tier, sr.tier) AS world_tier, rs.tier_reason AS local_tier_reason, sr.tier_reason,
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
          taxonOrder: r.taxon_order,
          family: r.family,
          sortOrder: r.sort_order,
          ebirdCode: r.ebird_code,
          tier: r.tier,
          localTier: r.local_tier,
          worldTier: r.world_tier,
          localTierReason: r.local_tier_reason,
          tierReason: r.tier_reason,
          isVagrant: r.is_vagrant,
          sensitiveByDefault: r.sensitive,
        })),
      };
    },
  );

  // Newest edit wins against the version the phone last saw: a mark the hub changed since (or
  // that the phone never saw but the hub has) comes back as a conflict with the hub's copy, and
  // the phone takes it. The same request twice changes nothing beyond the first. A mark is cleared
  // by writing it with state null and isTarget false, never deleted from here.
  app.post(
    "/sync/user-species",
    {
      preValidation: scope,
      schema: {
        body: Type.Object(
          {
            items: Type.Array(PushedMark, { maxItems: 500 }),
          },
          { additionalProperties: false },
        ),
        response: replies(MarksReply),
      },
    },
    async (request) => {
      const userId = request.user!.id;
      const { items } = request.body;
      return withTransaction(async (client) => {
        const unseen = items.filter((i) => !i.baseUpdatedAt).map((i) => i.scientificName);
        const held = new Set((await listUserSpeciesByName(client, userId, unseen)).map((m) => m.scientificName));
        const fresh = items.filter((i) => !held.has(i.scientificName) || i.baseUpdatedAt);
        const blocked = items.filter((i) => !fresh.includes(i)).map((i) => i.scientificName);
        const out = await applyPushedUserSpecies(client, userId, fresh as PushedUserSpecies[]);
        const conflicts = [...out.conflicts, ...(await listUserSpeciesByName(client, userId, blocked))];
        return { applied: out.stamps, conflicts };
      });
    },
  );
}
