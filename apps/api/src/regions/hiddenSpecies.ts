import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { isUuid } from "../lib/validate.js";
import { requireAuth } from "../auth/session.js";
import { MEDIA_CACHE_BUST } from "../config.js";

export async function regionHiddenSpeciesRoutes(app: FastifyInstance): Promise<void> {
  // Hides a species from one region's checklist only (unlike /species/:id/archive, which hides
  // it everywhere).
  app.post<{ Params: { regionId: string; speciesId: string } }>(
    "/regions/:regionId/species/:speciesId/hide",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!isUuid(request.params.regionId) || !isUuid(request.params.speciesId)) return reply.code(404).send({ error: "Region not found" });
      const userId = request.user!.id;
      const { regionId, speciesId } = request.params;
      const regionRes = await pool.query<{ id: string; sovereignty_group: string | null }>(
        `SELECT id, sovereignty_group FROM regions WHERE id = $1`,
        [regionId],
      );
      if (regionRes.rows.length === 0) return reply.code(404).send({ error: "Region not found" });
      await pool.query(
        `INSERT INTO region_species_hidden (user_id, region_id, species_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [userId, regionId, speciesId],
      );
      // A country-level hide also hides it in every province. Unhiding asks first instead, since
      // a hide is easy to undo and an unhide isn't.
      if (regionRes.rows[0].sovereignty_group != null) {
        await pool.query(
          `INSERT INTO region_species_hidden (user_id, region_id, species_id)
           SELECT $1, id, $2 FROM regions WHERE parent_id = $3
           ON CONFLICT DO NOTHING`,
          [userId, speciesId, regionId],
        );
      }
      return { ok: true };
    },
  );

  // Provinces with their own hide for this species, so the Hidden species page can ask before
  // unhiding them along with the country.
  app.get<{ Params: { regionId: string; speciesId: string } }>(
    "/regions/:regionId/species/:speciesId/hidden-children",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!isUuid(request.params.regionId) || !isUuid(request.params.speciesId)) return reply.code(404).send({ error: "Region not found" });
      const userId = request.user!.id;
      const { regionId, speciesId } = request.params;
      const res = await pool.query<{ id: string; name: string }>(
        `SELECT r.id, r.name FROM regions r
         JOIN region_species_hidden rsh ON rsh.region_id = r.id
         WHERE r.parent_id = $1 AND rsh.user_id = $2 AND rsh.species_id = $3
         ORDER BY r.name`,
        [regionId, userId, speciesId],
      );
      return { children: res.rows.map((r) => ({ regionId: r.id, regionName: r.name })) };
    },
  );

  app.delete<{ Params: { regionId: string; speciesId: string }; Querystring: { cascadeRegionIds?: string } }>(
    "/regions/:regionId/species/:speciesId/hide",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!isUuid(request.params.regionId) || !isUuid(request.params.speciesId)) return reply.code(404).send({ error: "Region not found" });
      const userId = request.user!.id;
      const { regionId, speciesId } = request.params;
      // The client confirms which provinces to unhide too and passes them here, so it's one call.
      const cascadeRegionIds = request.query.cascadeRegionIds ? request.query.cascadeRegionIds.split(",").filter(Boolean) : [];
      if (!cascadeRegionIds.every(isUuid)) return reply.code(404).send({ error: "Region not found" });
      const regionIds = [regionId, ...cascadeRegionIds];
      await pool.query(`DELETE FROM region_species_hidden WHERE user_id = $1 AND region_id = ANY($2) AND species_id = $3`, [
        userId,
        regionIds,
        speciesId,
      ]);
      return { ok: true };
    },
  );

  // Every region-scoped hide for the Hidden species page, grouped by region.
  app.get("/regions/hidden-species", { preHandler: requireAuth }, async (request) => {
    const userId = request.user!.id;
    const [res, regionsRes] = await Promise.all([
      pool.query<{
        species_id: string;
        scientific_name: string;
        common_name: string | null;
        reference_photo: string | null;
        has_reference_thumb: boolean;
        hidden_at: Date;
        region_id: string;
        region_name: string;
      }>(
        `SELECT s.id AS species_id, s.scientific_name, s.common_name,
                s.reference_photo, s.reference_thumb_path IS NOT NULL AS has_reference_thumb,
                rsh.hidden_at, r.id AS region_id, r.name AS region_name
         FROM region_species_hidden rsh
         JOIN species s ON s.id = rsh.species_id
         JOIN regions r ON r.id = rsh.region_id
         WHERE rsh.user_id = $1
         ORDER BY r.name, s.scientific_name`,
        [userId],
      ),
      // To walk each region up to its country (the one with sovereignty_group set).
      pool.query<{ id: string; name: string; parent_id: string | null; sovereignty_group: string | null }>(
        `SELECT id, name, parent_id, sovereignty_group FROM regions`,
      ),
    ]);
    const byId = new Map(regionsRes.rows.map((r) => [r.id, r]));
    function countryAncestorOf(regionId: string): { id: string; name: string } | null {
      let region = byId.get(regionId);
      while (region && region.sovereignty_group == null && region.parent_id) {
        const parent = byId.get(region.parent_id);
        if (!parent) break;
        region = parent;
      }
      return region ? { id: region.id, name: region.name } : null;
    }
    return {
      items: res.rows.map((r) => {
        const country = countryAncestorOf(r.region_id);
        return {
          speciesId: r.species_id,
          scientificName: r.scientific_name,
          commonName: r.common_name,
          referencePhoto: r.reference_photo,
          referenceThumbUrl: r.has_reference_thumb
            ? `/api/species/${r.species_id}/reference-photo/thumb?v=${MEDIA_CACHE_BUST}`
            : null,
          hiddenAt: r.hidden_at,
          regionId: r.region_id,
          regionName: r.region_name,
          countryId: country?.id ?? null,
          countryName: country?.name ?? null,
          isCountry: country?.id === r.region_id,
        };
      }),
    };
  });

  app.get<{ Params: { id: string } }>("/regions/:id/hidden-species", { preHandler: requireAuth }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(404).send({ error: "Region not found" });
    const userId = request.user!.id;
    const { id: regionId } = request.params;
    const res = await pool.query<{
      species_id: string;
      scientific_name: string;
      common_name: string | null;
      hidden_at: Date;
    }>(
      `SELECT s.id AS species_id, s.scientific_name, s.common_name, rsh.hidden_at
       FROM region_species_hidden rsh
       JOIN species s ON s.id = rsh.species_id
       WHERE rsh.user_id = $1 AND rsh.region_id = $2
       ORDER BY s.scientific_name`,
      [userId, regionId],
    );
    return {
      items: res.rows.map((r) => ({
        speciesId: r.species_id,
        scientificName: r.scientific_name,
        commonName: r.common_name,
        hiddenAt: r.hidden_at,
      })),
    };
  });
}
