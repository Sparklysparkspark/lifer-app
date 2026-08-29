import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireAuth } from "../auth/session.js";
import { toCollectionItem } from "./collectionItem.js";
import {
  OBSCURE_SPECIES_SQL,
  ALREADY_OWNED_SQL,
  NOT_ARCHIVED_SQL,
  SPECIES_UNLOCKED_SQL,
  getHideObscurePreference,
} from "../species/obscurity.js";

export async function collectionRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { taxon?: string } }>(
    "/collection",
    { preHandler: requireAuth },
    async (request) => {
      const userId = request.user!.id;
      const { taxon } = request.query;
      const hideObscure = await getHideObscurePreference(userId);

      // state per lifer-spec.md §1: collected (user_species row with state='collected'),
      // seen (state='seen' — nothing sets this yet, that's Phase 3's eBird import), else unseen.
      // Phase 8: ?taxon= filters by species.taxon_class (aves/mammalia/actinopterygii) — a
      // plain query param rather than a route segment, since "all taxa" (no filter) is a
      // completely valid, common view too.
      const res = await pool.query(
        `SELECT
           s.id AS species_id,
           s.scientific_name,
           s.common_name,
           s.taxon_class,
           s.family,
           s.reference_photo,
           s.reference_credit,
           s.reference_thumb_path IS NOT NULL AS has_reference_thumb,
           s.reference_focal_x,
           s.reference_focal_y,
           r.tier,
           t.endemic_country_iso3,
           t.endemic_region_label,
           us.state,
           us.cover_photo_id,
           us.card_crop_x,
           us.card_crop_y,
           us.card_crop_size,
           p.thumb_path IS NOT NULL AS has_cover_photo,
           sv.label AS cover_volume_label
         FROM species s
         LEFT JOIN species_rarity r ON r.species_id = s.id
         LEFT JOIN species_traits t ON t.species_id = s.id
         LEFT JOIN user_species us ON us.user_id = $1 AND us.species_id = s.id
         LEFT JOIN photos p ON p.id = us.cover_photo_id
         LEFT JOIN originals o ON o.capture_id = p.capture_id AND o.kind = 'jpeg'
         LEFT JOIN storage_volumes sv ON sv.id = o.volume_id
         LEFT JOIN user_archived_species uas ON uas.user_id = $1 AND uas.species_id = s.id
         WHERE ($2::text IS NULL OR s.taxon_class = $2) AND COALESCE(t.fully_extinct, false) = false
           AND ($3 = false OR ${ALREADY_OWNED_SQL} OR NOT ${OBSCURE_SPECIES_SQL})
           AND ${NOT_ARCHIVED_SQL}
           AND (${ALREADY_OWNED_SQL} OR ${SPECIES_UNLOCKED_SQL})
         ORDER BY s.sort_order NULLS LAST, s.scientific_name`,
        [userId, taxon ?? null, hideObscure],
      );

      const items = res.rows.map(toCollectionItem);

      return { items };
    },
  );

  // Same view as GET /collection, count-only — no reference photos/tier/crop fields to join
  // or serialize, just three numbers. Lets the header show a total instantly on a
  // region/taxon switch without waiting on the full (much heavier) item list to download and
  // render first — see CollectionPage.tsx, which fires this in parallel with /collection.
  app.get<{ Querystring: { taxon?: string } }>(
    "/collection/count",
    { preHandler: requireAuth },
    async (request) => {
      const userId = request.user!.id;
      const { taxon } = request.query;
      const hideObscure = await getHideObscurePreference(userId);

      const res = await pool.query<{ total: string; collected: string; seen: string }>(
        `SELECT
           count(*) AS total,
           count(*) FILTER (WHERE us.state = 'collected') AS collected,
           count(*) FILTER (WHERE us.state = 'seen') AS seen
         FROM species s
         LEFT JOIN species_traits t ON t.species_id = s.id
         LEFT JOIN user_species us ON us.user_id = $1 AND us.species_id = s.id
         LEFT JOIN user_archived_species uas ON uas.user_id = $1 AND uas.species_id = s.id
         WHERE ($2::text IS NULL OR s.taxon_class = $2) AND COALESCE(t.fully_extinct, false) = false
           AND ($3 = false OR ${ALREADY_OWNED_SQL} OR NOT ${OBSCURE_SPECIES_SQL})
           AND ${NOT_ARCHIVED_SQL}
           AND (${ALREADY_OWNED_SQL} OR ${SPECIES_UNLOCKED_SQL})`,
        [userId, taxon ?? null, hideObscure],
      );
      const row = res.rows[0];
      return { total: Number(row.total), collected: Number(row.collected), seen: Number(row.seen) };
    },
  );

  // Phase 4 (spec §9): "total collected, by tier, by family, by year" — all derived from
  // data already in place (species_rarity.tier, species.family, user_species.first_collected,
  // set once at upload time — see uploads/routes.ts), no schema changes needed.
  app.get("/collection/stats", { preHandler: requireAuth }, async (request) => {
    const userId = request.user!.id;

    const totalRes = await pool.query(
      `SELECT COUNT(*)::int AS total FROM user_species WHERE user_id = $1 AND state = 'collected'`,
      [userId],
    );

    const byTierRes = await pool.query<{ tier: string; count: number }>(
      `SELECT r.tier, COUNT(*)::int AS count
       FROM user_species us
       JOIN species_rarity r ON r.species_id = us.species_id
       WHERE us.user_id = $1 AND us.state = 'collected'
       GROUP BY r.tier`,
      [userId],
    );

    const byFamilyRes = await pool.query<{ family: string | null; count: number }>(
      `SELECT s.family, COUNT(*)::int AS count
       FROM user_species us
       JOIN species s ON s.id = us.species_id
       WHERE us.user_id = $1 AND us.state = 'collected'
       GROUP BY s.family
       ORDER BY count DESC, s.family ASC`,
      [userId],
    );

    const byYearRes = await pool.query<{ year: number; count: number }>(
      `SELECT EXTRACT(YEAR FROM us.first_collected)::int AS year, COUNT(*)::int AS count
       FROM user_species us
       WHERE us.user_id = $1 AND us.state = 'collected' AND us.first_collected IS NOT NULL
       GROUP BY year
       ORDER BY year ASC`,
      [userId],
    );

    const byTier: Record<string, number> = { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0, unrated: 0 };
    for (const row of byTierRes.rows) byTier[row.tier] = row.count;

    return {
      totalCollected: totalRes.rows[0].total,
      byTier,
      byFamily: byFamilyRes.rows.map((r) => ({ family: r.family ?? "Unknown", count: r.count })),
      byYear: byYearRes.rows.map((r) => ({ year: r.year, count: r.count })),
    };
  });

  app.patch<{ Params: { id: string }; Body: { photoId?: string } }>(
    "/species/:id/cover",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id: speciesId } = request.params;
      const { photoId } = request.body ?? {};
      const userId = request.user!.id;
      if (!photoId) return reply.code(400).send({ error: "photoId is required" });

      // Confirm this photo belongs to a capture the user owns, for this species.
      const ownershipRes = await pool.query(
        `SELECT p.id FROM photos p
         JOIN captures c ON c.id = p.capture_id
         WHERE p.id = $1 AND c.user_id = $2 AND c.species_id = $3`,
        [photoId, userId, speciesId],
      );
      if (ownershipRes.rows.length === 0) {
        return reply.code(403).send({ error: "That photo doesn't belong to you for this species" });
      }

      // Clear any saved crop — it was framed for whichever photo was previously the cover,
      // and carrying it over onto a different photo would look wrong.
      await pool.query(
        `UPDATE user_species SET cover_photo_id = $1, card_crop_x = NULL, card_crop_y = NULL, card_crop_size = NULL
         WHERE user_id = $2 AND species_id = $3`,
        [photoId, userId, speciesId],
      );
      return { ok: true };
    },
  );

  app.patch<{ Params: { id: string }; Body: { x?: number; y?: number; size?: number; reset?: boolean } }>(
    "/species/:id/card-crop",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id: speciesId } = request.params;
      const { x, y, size, reset } = request.body ?? {};
      const userId = request.user!.id;

      if (reset) {
        const res = await pool.query(
          `UPDATE user_species SET card_crop_x = NULL, card_crop_y = NULL, card_crop_size = NULL
           WHERE user_id = $1 AND species_id = $2`,
          [userId, speciesId],
        );
        if (res.rowCount === 0) return reply.code(404).send({ error: "No cover photo set for this species yet" });
        return { ok: true };
      }

      const valid =
        typeof x === "number" && x >= 0 && x <= 100 &&
        typeof y === "number" && y >= 0 && y <= 100 &&
        typeof size === "number" && size > 0 && size <= 100;
      if (!valid) {
        return reply.code(400).send({ error: "x, y, size must be numbers; x/y in [0,100], size in (0,100]" });
      }

      const res = await pool.query(
        `UPDATE user_species SET card_crop_x = $1, card_crop_y = $2, card_crop_size = $3
         WHERE user_id = $4 AND species_id = $5 AND cover_photo_id IS NOT NULL`,
        [x, y, size, userId, speciesId],
      );
      if (res.rowCount === 0) {
        return reply.code(404).send({ error: "No cover photo set for this species yet" });
      }
      return { ok: true };
    },
  );
}
