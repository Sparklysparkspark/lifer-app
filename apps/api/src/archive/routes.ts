import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { IdParams, Ok, Uuid, notFoundOnInvalidId, replies, withSchemas } from "../lib/schema.js";
import { requireAuth } from "../auth/session.js";
import { MEDIA_CACHE_BUST } from "@lifer/core/config.js";

// Archived species drop out of the "still to collect" lists and counts but stay searchable and
// viewable. Family actions run over the whole family server side.
const speciesNotFound = notFoundOnInvalidId("Species not found");
const SpeciesIdsBody = Type.Object(
  { speciesIds: Type.Array(Uuid(), { minItems: 1 }) },
  { additionalProperties: false },
);

export async function archiveRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  const byId = {
    preValidation: requireAuth,
    config: speciesNotFound,
    schema: { params: IdParams, response: replies(Ok) },
  };

  app.post("/species/:id/archive", byId, async (request, reply) => {
    const userId = request.user!.id;
    const { id: speciesId } = request.params;
    const speciesRes = await pool.query(`SELECT id FROM species WHERE id = $1`, [speciesId]);
    if (speciesRes.rows.length === 0) return reply.code(404).send({ error: "Species not found" });
    await pool.query(`INSERT INTO user_archived_species (user_id, species_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
      userId,
      speciesId,
    ]);
    return { ok: true };
  });

  app.delete("/species/:id/archive", byId, async (request) => {
    const userId = request.user!.id;
    const { id: speciesId } = request.params;
    await pool.query(`DELETE FROM user_archived_species WHERE user_id = $1 AND species_id = $2`, [userId, speciesId]);
    return { ok: true };
  });

  // Bulk archive by id list: the grid's groups are folk labels ("Owls" spans two families), so the
  // ids the client shows are the only reliable way to act on a group.
  app.post(
    "/archive/bulk",
    {
      preValidation: requireAuth,
      schema: {
        body: SpeciesIdsBody,
        response: replies(Type.Object({ ok: Type.Boolean(), archived: Type.Integer() })),
      },
    },
    async (request) => {
      const userId = request.user!.id;
      const { speciesIds } = request.body;
      // Never archives something already collected/seen, same exemption as ALREADY_OWNED_SQL.
      const res = await pool.query(
        `INSERT INTO user_archived_species (user_id, species_id)
       SELECT $1, s.id FROM species s
       LEFT JOIN user_species us ON us.user_id = $1 AND us.species_id = s.id
       WHERE s.id = ANY($2) AND us.state IS NULL
       ON CONFLICT DO NOTHING`,
        [userId, speciesIds],
      );
      return { ok: true, archived: res.rowCount ?? 0 };
    },
  );

  app.delete(
    "/archive/bulk",
    {
      preValidation: requireAuth,
      schema: {
        body: SpeciesIdsBody,
        response: replies(Type.Object({ ok: Type.Boolean(), unarchived: Type.Integer() })),
      },
    },
    async (request) => {
      const userId = request.user!.id;
      const { speciesIds } = request.body;
      const res = await pool.query(`DELETE FROM user_archived_species WHERE user_id = $1 AND species_id = ANY($2)`, [
        userId,
        speciesIds,
      ]);
      return { ok: true, unarchived: res.rowCount ?? 0 };
    },
  );

  // Every archived species, plus a family rollup for "unarchive this whole family".
  app.get("/archive", { preValidation: requireAuth, schema: {} }, async (request) => {
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
      // Built here with MEDIA_CACHE_BUST, since the file can be replaced in place.
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
