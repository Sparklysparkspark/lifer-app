import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireAuth } from "../auth/session.js";
import { MEDIA_CACHE_BUST } from "../config.js";

// Lets a user hide/archive species they don't care about completing (see migration 037) —
// removes them from the "still need to collect" checklist/count without touching any real
// data, and without blocking direct search or the species detail page. Bulk-by-family
// operates server-side over every species in that family (not just whatever's currently
// loaded/paginated client-side), so it can't silently miss species the client hasn't fetched.
export async function archiveRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string } }>("/species/:id/archive", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.user!.id;
    const { id: speciesId } = request.params;
    const speciesRes = await pool.query(`SELECT id FROM species WHERE id = $1`, [speciesId]);
    if (speciesRes.rows.length === 0) return reply.code(404).send({ error: "Species not found" });
    await pool.query(
      `INSERT INTO user_archived_species (user_id, species_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [userId, speciesId],
    );
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/species/:id/archive", { preHandler: requireAuth }, async (request) => {
    const userId = request.user!.id;
    const { id: speciesId } = request.params;
    await pool.query(`DELETE FROM user_archived_species WHERE user_id = $1 AND species_id = $2`, [userId, speciesId]);
    return { ok: true };
  });

  // Bulk archive/unarchive by an explicit id list — used for "archive this whole family/group"
  // actions. Takes ids rather than a (taxonClass, family) pair deliberately: the collection
  // grid's "group by family" view actually groups by a curated FOLK label (see
  // apps/web/src/lib/speciesGroups.ts — "Owls" spans both Strigidae and Tytonidae), which
  // doesn't correspond 1:1 with species.family, so the only reliable way to bulk-act on "every
  // species in the group the user is looking at" is the id list the client already has
  // rendered, not a re-derived family filter that could over- or under-match it.
  app.post<{ Body: { speciesIds?: string[] } }>("/archive/bulk", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.user!.id;
    const speciesIds = request.body?.speciesIds;
    if (!Array.isArray(speciesIds) || speciesIds.length === 0) {
      return reply.code(400).send({ error: "speciesIds must be a non-empty array" });
    }
    // Never archives something already collected/seen — same exemption as ALREADY_OWNED_SQL.
    const res = await pool.query(
      `INSERT INTO user_archived_species (user_id, species_id)
       SELECT $1, s.id FROM species s
       LEFT JOIN user_species us ON us.user_id = $1 AND us.species_id = s.id
       WHERE s.id = ANY($2) AND us.state IS NULL
       ON CONFLICT DO NOTHING`,
      [userId, speciesIds],
    );
    return { ok: true, archived: res.rowCount };
  });

  app.delete<{ Body: { speciesIds?: string[] } }>("/archive/bulk", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.user!.id;
    const speciesIds = request.body?.speciesIds;
    if (!Array.isArray(speciesIds) || speciesIds.length === 0) {
      return reply.code(400).send({ error: "speciesIds must be a non-empty array" });
    }
    const res = await pool.query(
      `DELETE FROM user_archived_species WHERE user_id = $1 AND species_id = ANY($2)`,
      [userId, speciesIds],
    );
    return { ok: true, unarchived: res.rowCount };
  });

  // Archive-management view: every archived species, plus a family-level rollup so the UI can
  // offer "unarchive this whole family" symmetric to the bulk archive action above.
  app.get("/archive", { preHandler: requireAuth }, async (request) => {
    const userId = request.user!.id;
    const res = await pool.query<{
      species_id: string;
      scientific_name: string;
      common_name: string | null;
      taxon_class: string;
      family: string | null;
      reference_photo: string | null;
      has_reference_thumb: boolean;
      archived_at: Date;
    }>(
      `SELECT s.id AS species_id, s.scientific_name, s.common_name, s.taxon_class, s.family,
              s.reference_photo, s.reference_thumb_path IS NOT NULL AS has_reference_thumb, uas.archived_at
       FROM user_archived_species uas
       JOIN species s ON s.id = uas.species_id
       WHERE uas.user_id = $1
       ORDER BY s.family NULLS LAST, s.scientific_name`,
      [userId],
    );

    const items = res.rows.map((r) => ({
      speciesId: r.species_id,
      scientificName: r.scientific_name,
      commonName: r.common_name,
      taxonClass: r.taxon_class,
      family: r.family,
      referencePhoto: r.reference_photo,
      // Built server-side (with a cache-busting version marker — see MEDIA_CACHE_BUST's own
      // comment) rather than a plain hasReferenceThumb boolean the frontend turns into a URL
      // itself, same convention as collectionItem.ts's coverPhotoUrl — this file's underlying
      // content can be overwritten in place by a restore pass without its path ever changing.
      referenceThumbUrl: r.has_reference_thumb
        ? `/api/species/${r.species_id}/reference-photo/thumb?v=${MEDIA_CACHE_BUST}`
        : null,
      archivedAt: r.archived_at,
    }));

    const byFamily = new Map<string, { taxonClass: string; family: string; count: number }>();
    for (const item of items) {
      const key = `${item.taxonClass}:${item.family ?? ""}`;
      if (!item.family) continue;
      const existing = byFamily.get(key);
      if (existing) existing.count++;
      else byFamily.set(key, { taxonClass: item.taxonClass, family: item.family, count: 1 });
    }

    return { items, families: [...byFamily.values()] };
  });
}
