// A species' rarity tier with its reasons, for the tier badge's popover, and the user's own tier
// for it, which wins on this install.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { requireAuth } from "../auth/session.js";
import { isUuid } from "../lib/validate.js";
import { TIER_ORDER } from "@lifer/shared";
import { IdParams, Nullable, Ok, Uuid, replies, withSchemas } from "../lib/schema.js";

const speciesNotFound = { status: 404, error: "Species not found" };

export async function tierRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  const tierOptions = {
    preValidation: requireAuth,
    config: { invalidInput: { params: speciesNotFound, querystring: { status: 404, error: "Region not found" } } },
    schema: { params: IdParams, querystring: Type.Object({ regionId: Type.Optional(Uuid()) }) },
  };
  app.get("/species/:id/tier", tierOptions, async (request) => {
    const { id } = request.params;
    const regionId = request.query.regionId;
    const [global, local, override] = await Promise.all([
      pool.query<{ tier: string | null; tier_reason: string | null; tier_explain: unknown }>(
        `SELECT tier, tier_reason, tier_explain FROM species_rarity WHERE species_id = $1`,
        [id],
      ),
      regionId
        ? pool.query<{
            local_tier: string | null;
            tier_reason: string | null;
            tier_explain: unknown;
            is_vagrant: boolean;
            name: string;
          }>(
            `SELECT rs.local_tier, rs.tier_reason, rs.tier_explain, rs.is_vagrant, r.name
             FROM region_species rs JOIN regions r ON r.id = rs.region_id WHERE rs.region_id = $1 AND rs.species_id = $2`,
            [regionId, id],
          )
        : null,
      pool.query<{ region_id: string | null; tier: string }>(
        `SELECT region_id, tier FROM user_tier_overrides WHERE user_id = $1 AND species_id = $2 AND (region_id = $3 OR region_id IS NULL)
         ORDER BY region_id NULLS LAST`,
        [request.user!.id, id, regionId ?? null],
      ),
    ]);
    const regionName = regionId
      ? (local?.rows[0]?.name ??
        (await pool.query<{ name: string }>(`SELECT name FROM regions WHERE id = $1`, [regionId])).rows[0]?.name ??
        null)
      : null;
    const own = override.rows[0];
    const iucn = await pool.query<{ iucn_status: string | null }>(
      `SELECT iucn_status FROM species_traits WHERE species_id = $1`,
      [id],
    );
    return {
      // Shown beside the tier, not part of it (conservation status isn't how hard a species is to find).
      iucnStatus: iucn.rows[0]?.iucn_status ?? null,
      global: {
        tier: global.rows[0]?.tier ?? null,
        reason: global.rows[0]?.tier_reason ?? null,
        explain: global.rows[0]?.tier_explain ?? null,
      },
      local: local?.rows[0]
        ? {
            tier: local.rows[0].local_tier,
            reason: local.rows[0].tier_reason,
            explain: local.rows[0].tier_explain,
            regionName,
          }
        : regionId
          ? { tier: null, reason: "no_data", explain: null, regionName }
          : null,
      override: own ? { tier: own.tier, everywhere: own.region_id == null } : null,
    };
  });

  // tier null removes the user's own tier; regionId null sets it everywhere.
  app.put(
    "/species/:id/tier-override",
    {
      preValidation: requireAuth,
      config: { invalidInput: { params: speciesNotFound } },
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            // A plain string: a malformed region answers 404 like an unknown one (checked below).
            regionId: Type.Optional(Nullable(Type.String())),
            tier: Type.Optional(Nullable(Type.Enum([...TIER_ORDER]))),
          },
          { additionalProperties: false },
        ),
        response: replies(Ok),
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const regionId = request.body.regionId || null;
      const tier = request.body.tier ?? null;
      if (regionId !== null && !isUuid(regionId)) return reply.code(404).send({ error: "Region not found" });
      const userId = request.user!.id;
      await pool.query(
        `DELETE FROM user_tier_overrides WHERE user_id = $1 AND species_id = $2 AND region_id IS NOT DISTINCT FROM $3`,
        [userId, id, regionId],
      );
      if (tier) {
        await pool.query(
          `INSERT INTO user_tier_overrides (user_id, region_id, species_id, tier) VALUES ($1, $2, $3, $4)`,
          [userId, regionId, id, tier],
        );
      }
      return { ok: true };
    },
  );
}
