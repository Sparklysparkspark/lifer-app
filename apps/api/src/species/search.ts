// GET /species: the species picker's search.
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireScope } from "../auth/session.js";
import { isUuid } from "../lib/validate.js";
import { log } from "../lib/log.js";

interface SearchQuery {
  q?: string;
  regionId?: string;
}

// GET /species over species_search_names (migration 111). $1 normalized text, $2 the same with
// LIKE wildcards escaped, $3 user id, $4 optional region id. Tiers: exact 4/6-letter code, exact
// name, whole-name prefix, word prefix, code prefix, family prefix, fuzzy. Region checklist and the user's own
// collection add a small boost inside a tier, never across one.
const SPECIES_SEARCH_SQL = `
  WITH name_hits AS (
    SELECT n.species_id,
      MAX(CASE
        WHEN n.kind = 'code' THEN
          CASE WHEN n.name_norm = $1 AND length($1) IN (4, 6) THEN 100
               WHEN n.name_norm LIKE $2 || '%' THEN 40
               ELSE 0 END
        WHEN n.kind IN ('common', 'scientific') THEN
          CASE WHEN n.name_norm = $1 THEN 90
               WHEN n.name_norm LIKE $2 || '%' THEN 70 + 10 * similarity(n.name_norm, $1)
               WHEN n.name_norm LIKE '% ' || $2 || '%' THEN 55 + 10 * word_similarity($1, n.name_norm)
               ELSE 40 * similarity(n.name_norm, $1) + 20 * word_similarity($1, n.name_norm) END
        -- Aliases and old names rank a step below the same kind of match on a current name.
        ELSE
          CASE WHEN n.name_norm = $1 THEN 80
               WHEN n.name_norm LIKE $2 || '%' THEN 50 + 10 * similarity(n.name_norm, $1)
               WHEN n.name_norm LIKE '% ' || $2 || '%' THEN 45 + 10 * word_similarity($1, n.name_norm)
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
    SELECT s.id AS species_id, 30 AS score FROM species s
    WHERE length($1) >= 3 AND lifer_search_norm(s.family) LIKE $2 || '%'
  ),
  hits AS (
    SELECT species_id, MAX(score) AS score
    FROM (SELECT * FROM name_hits UNION ALL SELECT * FROM family_hits) u
    WHERE score > 0
    GROUP BY species_id
  )
  SELECT s.id, s.scientific_name, s.common_name,
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
  ORDER BY rank DESC, s.common_name IS NULL, length(COALESCE(s.common_name, s.scientific_name)), s.sort_order NULLS LAST, s.scientific_name
  LIMIT 20`;

// A --disable-triggers catalog restore (desktop first boot) leaves species_search_names empty.
// Rebuilt once in the background at startup; until then GET /species uses the legacy scan.
let searchNamesReady = false;
let searchNamesCheck: Promise<void> | null = null;
/** Resolves once the startup check (and any rebuild) has finished. */
export function whenSpeciesSearchReady(): Promise<void> {
  return searchNamesCheck ?? Promise.resolve();
}
async function ensureSpeciesSearchNames(): Promise<void> {
  const res = await pool.query<{ empty: boolean; has_species: boolean }>(
    `SELECT NOT EXISTS (SELECT 1 FROM species_search_names) AS empty, EXISTS (SELECT 1 FROM species) AS has_species`,
  );
  if (res.rows[0].empty && res.rows[0].has_species) {
    log.info("Building the species search index");
    await pool.query(`SELECT refresh_species_search_names(NULL)`);
  }
  searchNamesReady = true;
}

export async function speciesSearchRoutes(app: FastifyInstance): Promise<void> {
  searchNamesCheck ??= ensureSpeciesSearchNames().catch((err) => log.error({ err }, "Species search index check failed"));

  app.get<{ Querystring: SearchQuery }>("/species", { preHandler: requireScope("species.read") }, async (request, reply) => {
    const q = (request.query.q ?? "").trim();
    const userId = request.user!.id;

    if (!q) {
      // No query yet: pin the user's most recently photographed species first.
      const recent = await pool.query(
        `SELECT s.id, s.scientific_name, s.common_name, u.last_used
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

    if (request.query.regionId && !isUuid(request.query.regionId)) {
      return reply.code(400).send({ error: "regionId must be a UUID" });
    }
    if (searchNamesReady) {
      const norm = (await pool.query<{ n: string | null }>(`SELECT lifer_search_norm($1) AS n`, [q])).rows[0].n ?? "";
      if (!norm) return { results: [] };
      const like = norm.replace(/[\\%_]/g, (m) => `\\${m}`);
      const res = await pool.query(SPECIES_SEARCH_SQL, [norm, like, userId, request.query.regionId || null]);
      return { results: res.rows };
    }

    // Legacy scan, used only until species_search_names is built: fuzzy match on common and
    // scientific names and aliases, prefix match on codes, genus and family (ranked lower).
    // Fully extinct species can't be photographed, so they're left out.
    const res = await pool.query(
      `SELECT s.id, s.scientific_name, s.common_name,
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
  });
}
