// GET /species: the species picker's search. GET /species/merges: catalog entries folded into others.
import type { FastifyInstance } from "fastify";
import { Type, type Static } from "typebox";
import { pool, withTransaction } from "@lifer/core/db.js";
import { requireScope } from "../auth/session.js";
import { Nullable, Uuid, replies, withSchemas } from "../lib/schema.js";
import { log } from "@lifer/core/lib/log.js";
import { GROUP_TERMS, normalizeWordForm } from "@lifer/shared";

const SearchQuery = Type.Object({
  q: Type.Optional(Type.String({ description: "Search text. Empty returns your most recently photographed species" })),
  regionId: Type.Optional(Uuid({ description: "Rank species on this region's checklist higher" })),
});

// The recent-species list (no q) has no rank.
const SearchResults = Type.Object({
  results: Type.Array(
    Type.Object({
      id: Type.String({ format: "uuid" }),
      scientific_name: Type.String(),
      common_name: Nullable(Type.String()),
      aba_code: Type.Optional(Nullable(Type.String())),
      ebird_code: Type.Optional(Nullable(Type.String())),
      // Keys to match the species in other sources.
      gbif_key: Type.Optional(Type.Integer({ description: "GBIF backbone taxon key" })),
      inat_taxon_id: Type.Optional(Nullable(Type.Integer())),
      taxon_class: Type.Optional(Nullable(Type.String())),
      rank: Type.Optional(Type.Number({ description: "Higher is better" })),
    }),
  ),
});

type SpeciesHit = Static<typeof SearchResults>["results"][number];

// GET /species over species_search_names (migration 111). $1 normalized text, $2 the same with
// LIKE wildcards escaped, $3 user id, $4 optional region id, $5 the GroupPredicate a group word
// ("raptors") names, as JSON. Tiers: exact 4/6-letter code, exact name, whole-name prefix, group,
// word prefix, code prefix, family prefix, compound ending, fuzzy. A compound ending is one word of
// 3+ letters ending an English name's last word ("ray": Southern Stingray), as nameMatchScore
// does. Fuzzy and mid-word hits show only when nothing else matches ("purple finch" never lists
// Purple Martin). Region checklist and the user's own collection add a small boost inside a tier.
const SPECIES_SEARCH_SQL = `
  WITH name_hits AS (
    SELECT n.species_id,
      BOOL_OR(n.name_norm LIKE $2 || '%' OR n.name_norm LIKE '% ' || $2 || '%'
              OR (n.kind IN ('common', 'alias') AND length($1) >= 3 AND position(' ' in $1) = 0
                  AND n.name_norm LIKE '%_' || $2)) AS literal,
      MAX(CASE
        WHEN n.kind = 'code' THEN
          CASE WHEN n.name_norm = $1 AND length($1) IN (4, 6) THEN 100
               WHEN n.name_norm LIKE $2 || '%' THEN 40
               ELSE 0 END
        WHEN n.kind IN ('common', 'scientific') THEN
          CASE WHEN n.name_norm = $1 THEN 90
               WHEN n.name_norm LIKE $2 || '%' THEN 70 + 10 * similarity(n.name_norm, $1)
               WHEN n.name_norm LIKE '% ' || $2 || '%' THEN 55 + 10 * word_similarity($1, n.name_norm)
               WHEN n.kind = 'common' AND length($1) >= 3 AND position(' ' in $1) = 0
                    AND n.name_norm LIKE '%_' || $2 THEN 30
               ELSE 40 * similarity(n.name_norm, $1) + 20 * word_similarity($1, n.name_norm) END
        -- Aliases and old names rank a step below the same kind of match on a current name.
        ELSE
          CASE WHEN n.name_norm = $1 THEN 80
               WHEN n.name_norm LIKE $2 || '%' THEN 50 + 10 * similarity(n.name_norm, $1)
               WHEN n.name_norm LIKE '% ' || $2 || '%' THEN 45 + 10 * word_similarity($1, n.name_norm)
               WHEN n.kind = 'alias' AND length($1) >= 3 AND position(' ' in $1) = 0
                    AND n.name_norm LIKE '%_' || $2 THEN 25
               ELSE 35 * similarity(n.name_norm, $1) + 15 * word_similarity($1, n.name_norm) END
      END) AS score
    FROM species_search_names n
    WHERE n.name_norm LIKE $2 || '%'
       OR (length($1) >= 3 AND (n.name_norm LIKE '%' || $2 || '%' OR $1 <% n.name_norm))
       -- Whole-name fuzzy matching only once there's enough text for it to mean something.
       OR (length($1) >= 5 AND n.name_norm % $1)
    GROUP BY n.species_id
  ),
  family_hits AS (
    SELECT s.id AS species_id, true AS literal, 30 AS score FROM species s
    WHERE length($1) >= 3 AND lifer_search_norm(s.family) LIKE $2 || '%'
  ),
  -- speciesInGroup (searchTaxonSynonyms.ts) in SQL; no rows when $5 is null.
  group_hits AS (
    SELECT s.id AS species_id, true AS literal, 60 AS score
    FROM jsonb_to_record($5::jsonb) AS g(classes text[], orders text[], families text[], "excludeClasses" text[],
           "excludeOrders" text[], "excludeFamilies" text[], "excludeNameWords" text[], "includeNameWords" text[])
    JOIN species s
      ON lower(s.taxon_class) = ANY(g.classes) OR lower(s.taxon_order) = ANY(g.orders) OR lower(s.family) = ANY(g.families)
    WHERE NOT COALESCE(lower(s.taxon_class) = ANY(g."excludeClasses") OR lower(s.taxon_order) = ANY(g."excludeOrders")
                       OR lower(s.family) = ANY(g."excludeFamilies"), false)
      AND NOT COALESCE(lower(s.common_name) ~ ('\\m(' || array_to_string(g."excludeNameWords", '|') || ')\\M'), false)
      AND COALESCE(lower(s.common_name) ~ ('\\m(' || array_to_string(g."includeNameWords", '|') || ')\\M'), true)
  ),
  hits AS (
    SELECT species_id, BOOL_OR(literal) AS literal, MAX(score) AS score
    FROM (SELECT * FROM name_hits UNION ALL SELECT * FROM family_hits UNION ALL SELECT * FROM group_hits) u
    WHERE score > 0
    GROUP BY species_id
  )
  SELECT s.id, s.scientific_name, s.common_name, s.aba_code, s.ebird_code, s.gbif_key, s.inat_taxon_id, s.taxon_class, h.literal,
         ((h.score
           + CASE us.state WHEN 'collected' THEN 6 WHEN 'seen' THEN 3 ELSE 0 END
           + CASE WHEN $4::uuid IS NOT NULL AND EXISTS (
               SELECT 1 FROM region_species rs WHERE rs.region_id = $4::uuid AND rs.species_id = s.id
             ) THEN 8 ELSE 0 END
         ) / 100.0)::float8 AS rank
  FROM hits h
  JOIN species s ON s.id = h.species_id
  LEFT JOIN species_traits t ON t.species_id = s.id
  LEFT JOIN user_species us ON us.user_id = $3 AND us.species_id = s.id
  WHERE COALESCE(t.fully_extinct, false) = false
    AND (h.literal OR NOT EXISTS (SELECT 1 FROM hits WHERE literal))
  ORDER BY rank DESC, s.common_name IS NULL, length(COALESCE(s.common_name, s.scientific_name)), s.sort_order NULLS LAST, s.scientific_name
  LIMIT 20`;

// A first catalog load skips row triggers (catalogSeedUpdate.ts), leaving species_search_names
// empty. Rebuilt in the background at startup and after that load; until then GET /species uses
// the legacy scan.
let searchNamesReady = false;
let searchNamesCheck: Promise<void> | null = null;
// Small enough that a pack apply or catalog update queues behind one batch only briefly.
const REBUILD_BATCH = 5000;
/** Resolves once the startup check (and any rebuild) has finished. */
export function whenSpeciesSearchReady(): Promise<void> {
  return searchNamesCheck ?? Promise.resolve();
}
async function buildSpeciesSearchNames(rebuild: boolean): Promise<void> {
  const res = await pool.query<{ empty: boolean; has_species: boolean }>(
    `SELECT NOT EXISTS (SELECT 1 FROM species_search_names) AS empty, EXISTS (SELECT 1 FROM species) AS has_species`,
  );
  const { empty, has_species } = res.rows[0];
  if (has_species && (empty || rebuild)) {
    // Each species' names are swapped in one transaction, so search keeps working meanwhile.
    if (empty) searchNamesReady = false;
    log.info("Building the species search index");
    let after = "00000000-0000-0000-0000-000000000000";
    for (;;) {
      // Under the reference-data lock, so pack applies and catalog updates (which rename species
      // across several statements) never interleave with a batch. Species rows are locked first,
      // in id order, then their names: the order a species delete takes them in.
      const ids = await withTransaction(
        async (client) => {
          const res = await client.query<{ id: string }>(
            `SELECT id FROM species WHERE id > $1 ORDER BY id LIMIT $2 FOR KEY SHARE`,
            [after, REBUILD_BATCH],
          );
          const batch = res.rows.map((r) => r.id);
          if (batch.length) await client.query(`SELECT refresh_species_search_names($1::uuid[])`, [batch]);
          return batch;
        },
        { lockReferenceData: true },
      );
      if (ids.length < REBUILD_BATCH) break;
      after = ids[ids.length - 1];
    }
  }
  searchNamesReady = true;
}
/** Builds the search names when the catalog has species but they have none, or always with
 *  `rebuild`. Never throws. */
export function ensureSpeciesSearchNames(rebuild = false): Promise<void> {
  // Chained, so two rebuilds never overlap and awaiting the latest covers both.
  searchNamesCheck = (searchNamesCheck ?? Promise.resolve())
    .then(() => buildSpeciesSearchNames(rebuild))
    .catch((err) => log.error({ err }, "Species search index check failed"));
  return searchNamesCheck;
}

export async function speciesSearchRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  if (!searchNamesCheck) void ensureSpeciesSearchNames();

  // Old species ids an integration may still hold, each with the species it lives on as now
  // (migration 113). A survivor merged again later resolves to its own survivor.
  app.get(
    "/species/merges",
    {
      preValidation: requireScope("species.read"),
      schema: {
        querystring: Type.Object({
          since: Type.Optional(
            Type.String({ format: "date-time", description: "Only merges applied after this time" }),
          ),
        }),
        response: replies(
          Type.Object({
            merges: Type.Array(
              Type.Object({
                oldSpeciesId: Uuid(),
                newSpeciesId: Uuid({ description: "The species it is now, after any later merges" }),
                oldScientificName: Type.String(),
                mergedAt: Type.String({ format: "date-time" }),
              }),
            ),
          }),
        ),
      },
    },
    async (request) => {
      const res = await pool.query<{
        old_species_id: string;
        new_species_id: string;
        old_scientific_name: string;
        merged_at: Date;
      }>(
        `WITH RECURSIVE chain AS (
           SELECT old_species_id AS start, new_species_id AS target, 1 AS depth FROM species_merges
           UNION ALL
           SELECT c.start, m.new_species_id, c.depth + 1 FROM chain c JOIN species_merges m ON m.old_species_id = c.target
           WHERE c.depth < 20
         )
         SELECT m.old_species_id, m.old_scientific_name, m.merged_at,
                (SELECT c.target FROM chain c WHERE c.start = m.old_species_id ORDER BY c.depth DESC LIMIT 1) AS new_species_id
         FROM species_merges m
         WHERE $1::timestamptz IS NULL OR m.merged_at > $1::timestamptz
         ORDER BY m.merged_at, m.old_species_id`,
        [request.query.since ?? null],
      );
      return {
        merges: res.rows.map((r) => ({
          oldSpeciesId: r.old_species_id,
          newSpeciesId: r.new_species_id,
          oldScientificName: r.old_scientific_name,
          mergedAt: r.merged_at.toISOString(),
        })),
      };
    },
  );

  app.get(
    "/species",
    {
      preValidation: requireScope("species.read"),
      schema: { querystring: SearchQuery, response: replies(SearchResults) },
    },
    async (request) => {
      const q = (request.query.q ?? "").trim();
      const userId = request.user!.id;

      if (!q) {
        // No query yet: pin the user's most recently photographed species first.
        const recent = await pool.query(
          `SELECT s.id, s.scientific_name, s.common_name, s.aba_code, s.ebird_code, s.gbif_key, s.inat_taxon_id, s.taxon_class, u.last_used
         FROM (
           SELECT species_id, MAX(created_at) AS last_used
           FROM captures
           WHERE user_id = $1 AND species_id IS NOT NULL
           GROUP BY species_id
         ) u
         JOIN species s ON s.id = u.species_id
         ORDER BY u.last_used DESC
         LIMIT 10`,
          [userId],
        );
        return { results: recent.rows };
      }

      if (searchNamesReady) {
        const norm = (await pool.query<{ n: string | null }>(`SELECT lifer_search_norm($1) AS n`, [q])).rows[0].n ?? "";
        if (!norm) return { results: [] };
        const run = async (text: string) => {
          const like = text.replace(/[\\%_]/g, (m) => `\\${m}`);
          const group = GROUP_TERMS.get(text) ?? GROUP_TERMS.get(normalizeWordForm(text));
          const res = await pool.query<SpeciesHit & { literal: boolean }>(SPECIES_SEARCH_SQL, [
            text,
            like,
            userId,
            request.query.regionId || null,
            group ? JSON.stringify(group.predicate) : null,
          ]);
          return res.rows;
        };
        let rows = await run(norm);
        // "foxes", "geese": the singular when the plural fits no name.
        const singular = norm.split(" ").map(normalizeWordForm).join(" ");
        if (singular !== norm && !rows.some((r) => r.literal)) rows = await run(singular);
        return { results: rows.map(({ literal: _literal, ...r }) => r) };
      }

      // Legacy scan, used only until species_search_names is built: fuzzy match on common and
      // scientific names and aliases, prefix match on codes, genus and family (ranked lower).
      // Fully extinct species can't be photographed, so they're left out.
      const res = await pool.query(
        `SELECT s.id, s.scientific_name, s.common_name, s.aba_code, s.ebird_code, s.gbif_key, s.inat_taxon_id, s.taxon_class,
              GREATEST(
                similarity(s.common_name, $1),
                similarity(s.scientific_name, $1),
                COALESCE((SELECT MAX(similarity(a, $1)) FROM unnest(s.common_name_aliases) a), 0),
                -- ABA (4-letter) and eBird (6-letter) codes rank with a real name match: someone
                -- typing a code knows exactly which species they mean.
                CASE WHEN s.aba_code ILIKE $1 || '%' OR s.ebird_code ILIKE $1 || '%' THEN 1 ELSE 0 END,
                CASE WHEN s.genus ILIKE $1 || '%' OR s.family ILIKE $1 || '%' THEN 0.3 ELSE 0 END
              ) AS rank
       FROM species s
       LEFT JOIN species_traits t ON t.species_id = s.id
       WHERE (
         s.common_name % $1 OR s.scientific_name % $1 OR s.common_name ILIKE '%' || $1 || '%'
         OR EXISTS (SELECT 1 FROM unnest(s.common_name_aliases) a WHERE a % $1 OR a ILIKE '%' || $1 || '%')
         OR s.genus ILIKE $1 || '%' OR s.family ILIKE $1 || '%'
         OR s.aba_code ILIKE $1 || '%' OR s.ebird_code ILIKE $1 || '%'
       )
         AND COALESCE(t.fully_extinct, false) = false
       ORDER BY rank DESC
       LIMIT 20`,
        [q],
      );
      return { results: res.rows };
    },
  );
}
