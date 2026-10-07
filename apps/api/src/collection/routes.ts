import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyReply } from "fastify";
import { Type } from "typebox";
import type { PoolClient } from "pg";
import { pool } from "@lifer/core/db.js";
import { IdParams, Nullable, Ok, Uuid, notFoundOnInvalidId, replies, withSchemas } from "../lib/schema.js";
import { requireAuth } from "../auth/session.js";
import { toCollectionItem } from "./collectionItem.js";
import { markNameChanged } from "../species/speciesSplits.js";
import { syncCaptureXmpSidecarsLogged } from "../uploads/xmpSidecarSync.js";
import { detectDefaultCardCrop } from "../species/detectAndCrop.js";
import {
  obscureSpeciesSql,
  ALREADY_OWNED_SQL,
  NOT_ARCHIVED_SQL,
  getObscurityPreferences,
} from "../species/obscurity.js";
import { isValidCrop } from "../lib/crop.js";

// Best-effort re-sync of the previous cover's capture so its "Lifer:Cover" keyword comes off.
async function syncCoverCaptureXmp(userId: string, photoId: string | null): Promise<void> {
  if (!photoId) return;
  const res = await pool.query<{ capture_id: string }>(`SELECT capture_id FROM photos WHERE id = $1`, [photoId]);
  if (res.rows[0]) await syncCaptureXmpSidecarsLogged(userId, res.rows[0].capture_id);
}

// Species a downloaded pack covers, computed once per request instead of SPECIES_UNLOCKED_SQL's
// two EXISTS subqueries per catalog row. Same logic as obscurity.ts's SPECIES_UNLOCKED_SQL, except
// for hand-imported species, which COLLECTION_WHERE counts per user through their additions.
const UNLOCKED_SPECIES_CTE = `pack_regions AS MATERIALIZED (
  -- The handful of regions a downloaded pack covers, resolved first so region_species is read
  -- through its (region_id, species_id) key instead of scanned in full.
  SELECT r2.id AS region_id, dp.taxon
  FROM regions r2
  LEFT JOIN regions parent2 ON parent2.id = r2.parent_id
  JOIN downloaded_packs dp ON dp.region = (
    CASE WHEN COALESCE(array_length(parent2.external_codes, 1), 0) = 0 THEN r2.name ELSE parent2.name END
  )
),
unlocked AS (
  SELECT rs2.species_id
  FROM region_species rs2
  JOIN pack_regions pr ON pr.region_id = rs2.region_id
  JOIN species s2 ON s2.id = rs2.species_id
  -- The ANY(ARRAY(...)) is what makes the planner use the region_id index here.
  WHERE rs2.region_id = ANY (ARRAY(SELECT region_id FROM pack_regions))
    AND (pr.taxon IS NULL OR pr.taxon = s2.taxon_class)
  UNION
  SELECT szs.species_id
  FROM sea_zone_species szs
  JOIN sea_zones sz ON sz.id = szs.sea_zone_id
  JOIN downloaded_packs dp2 ON dp2.region = sz.name
)`;

const COLLECTION_WHERE = (maxDepthM: number) => `
  WHERE (($2::text[] IS NULL) OR ($2 @> ARRAY['other-taxa']::text[] AND s.is_other_taxa = true) OR s.taxon_class = ANY($2)) AND COALESCE(t.fully_extinct, false) = false
    AND ($3 = false OR ${ALREADY_OWNED_SQL} OR NOT ${obscureSpeciesSql(maxDepthM)})
    AND ${NOT_ARCHIVED_SQL}
    AND (${ALREADY_OWNED_SQL} OR s.id IN (SELECT species_id FROM unlocked)
      -- One you added to a checklist yourself counts even without its pack (regions/checklistAdditions.ts).
      -- Hand-imported species are additions too, so another user's imports stay out of your list.
      OR s.id IN (SELECT species_id FROM region_species_user_added WHERE user_id = $1)
      OR s.id IN (SELECT species_id FROM sea_zone_species_user_added WHERE user_id = $1))`;

// state: collected (user_species row with state='collected'), seen (state='seen'), else unseen.
// ?taxon= filters by species.taxon_class.
export function collectionQuerySql(maxDepthM: number): string {
  return `WITH
    -- Every distinct calendar year this user has ANY real capture of each species (not just the
    -- first-ever one), for "big year" style filters. From captures, not captures_all: a trashed
    -- photo shouldn't count as "found this year" any more than it counts as a cover photo.
    years AS (
      SELECT cy.species_id, array_agg(DISTINCT EXTRACT(YEAR FROM cy.taken_at)::int) AS captured_years
      FROM captures cy
      WHERE cy.user_id = $1 AND cy.species_id IS NOT NULL AND cy.taken_at IS NOT NULL
      GROUP BY cy.species_id
    ),
    ${UNLOCKED_SPECIES_CTE}
    SELECT
      s.id AS species_id,
      s.scientific_name,
      s.common_name,
      s.taxon_class,
      s.family,
      s.taxon_order,
      s.reference_photo,
      s.reference_credit,
      s.reference_thumb_path IS NOT NULL AS has_reference_thumb,
      s.reference_focal_x,
      s.reference_focal_y,
      s.is_other_taxa,
      s.inat_iconic_taxon,
      r.tier,
      r.tier_reason,
      uto.tier AS override_tier,
      t.endemic_country_iso3,
      t.endemic_region_label,
      t.occurrence_count,
      t.last_occurrence_year,
      t.depth_min_m,
      us.state,
      us.is_target,
      us.was_ghost_when_collected,
      us.was_lost_when_collected,
      us.cover_photo_id,
      us.card_crop_x,
      us.card_crop_y,
      us.card_crop_size,
      -- A trashed capture doesn't clear cover_photo_id (only purging it does): gating on cc.id
      -- (the trash-excluding captures view) stops a card keeping a soft-deleted cover photo.
      (p.thumb_path IS NOT NULL AND cc.id IS NOT NULL) AS has_cover_photo,
      sv.label AS cover_volume_label,
      y.captured_years
    FROM species s
    LEFT JOIN species_rarity r ON r.species_id = s.id
    LEFT JOIN user_tier_overrides uto ON uto.user_id = $1 AND uto.species_id = s.id AND uto.region_id IS NULL
    LEFT JOIN species_traits t ON t.species_id = s.id
    LEFT JOIN user_species us ON us.user_id = $1 AND us.species_id = s.id
    LEFT JOIN photos p ON p.id = us.cover_photo_id
    LEFT JOIN captures cc ON cc.id = p.capture_id
    LEFT JOIN originals o ON o.capture_id = p.capture_id AND o.kind = 'jpeg'
    LEFT JOIN storage_volumes sv ON sv.id = o.volume_id
    LEFT JOIN user_archived_species uas ON uas.user_id = $1 AND uas.species_id = s.id
    LEFT JOIN years y ON y.species_id = s.id
    ${COLLECTION_WHERE(maxDepthM)}
    ORDER BY s.sort_order NULLS LAST, s.scientific_name`;
}

export function collectionCountSql(maxDepthM: number): string {
  return `WITH ${UNLOCKED_SPECIES_CTE}
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE us.state = 'collected') AS collected,
      count(*) FILTER (WHERE us.state = 'seen') AS seen
    FROM species s
    LEFT JOIN species_traits t ON t.species_id = s.id
    LEFT JOIN user_species us ON us.user_id = $1 AND us.species_id = s.id
    LEFT JOIN user_archived_species uas ON uas.user_id = $1 AND uas.species_id = s.id
    ${COLLECTION_WHERE(maxDepthM)}`;
}

// New per process, so a restart (new code, new config) never answers 304 for an old body.
const BOOT_ID = randomBytes(6).toString("hex");

interface CollectionVersion {
  notModified: boolean;
  client: PoolClient;
  release: () => void;
}

// Weak ETag for the collection views. collection_data_version (migration 111) is bumped by a
// statement trigger on every table these queries read. It's read before the snapshot is taken,
// and the snapshot's in-progress transactions go into the tag too, so a write that bumped the
// version but hadn't committed yet can't leave an old body cached under the final tag. The
// returned client holds that REPEATABLE READ snapshot for the data query that follows.
async function collectionVersion(
  reply: FastifyReply,
  ifNoneMatch: string | undefined,
  params: unknown[],
): Promise<CollectionVersion> {
  const seq = await pool
    .query<{ v: string }>(
      `SELECT CASE WHEN is_called THEN last_value ELSE 0 END::text AS v FROM collection_data_version`,
    )
    .catch(() => null);
  const client = await pool.connect();
  const release = () => {
    client
      .query("COMMIT")
      .catch(() => {})
      .finally(() => client.release());
  };
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const snap = await client.query<{ xip: string | null }>(
      `SELECT string_agg(x::text, '.' ORDER BY x::text) AS xip FROM pg_snapshot_xip(pg_current_snapshot()) x`,
    );
    if (!seq) return { notModified: false, client, release };
    const tag = createHash("sha1")
      .update(JSON.stringify([BOOT_ID, seq.rows[0].v, snap.rows[0].xip, ...params]))
      .digest("base64url")
      .slice(0, 22);
    const etag = `W/"c-${tag}"`;
    reply.header("ETag", etag);
    reply.header("Cache-Control", "private, no-cache");
    const matches = !!ifNoneMatch && ifNoneMatch.split(",").some((t) => t.trim() === etag);
    if (matches) {
      release();
      return { notModified: true, client, release: () => {} };
    }
    return { notModified: false, client, release };
  } catch (err) {
    release();
    throw err;
  }
}

const TaxonQuery = Type.Object({
  taxon: Type.Optional(Type.String({ description: "Comma-separated taxon classes, e.g. aves,mammalia" })),
});
const speciesNotFound = notFoundOnInvalidId("Species not found");
// Percent of the photo, the same bounds as lib/crop.ts isValidCrop.
const Percent = Type.Number({ minimum: 0, maximum: 100 });

export async function collectionRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.get(
    "/collection",
    { preValidation: requireAuth, schema: { querystring: TaxonQuery } },
    async (request, reply) => {
      const userId = request.user!.id;
      const taxa = request.query.taxon ? request.query.taxon.split(",").filter(Boolean) : null;
      const { hideObscure, maxDepthM } = await getObscurityPreferences(userId);

      const version = await collectionVersion(reply, request.headers["if-none-match"], [
        "list",
        userId,
        taxa,
        hideObscure,
        maxDepthM,
      ]);
      if (version.notModified) return reply.code(304).send();

      const res = await version.client
        .query(collectionQuerySql(maxDepthM), [userId, taxa, hideObscure])
        .finally(() => version.release());

      const items = await markNameChanged(
        userId,
        res.rows.map((row) => toCollectionItem(row, maxDepthM)),
      );

      return { items };
    },
  );

  // GET /collection's counts only, so the header can show a total before the list loads.
  app.get(
    "/collection/count",
    { preValidation: requireAuth, schema: { querystring: TaxonQuery } },
    async (request, reply) => {
      const userId = request.user!.id;
      const taxa = request.query.taxon ? request.query.taxon.split(",").filter(Boolean) : null;
      const { hideObscure, maxDepthM } = await getObscurityPreferences(userId);

      const version = await collectionVersion(reply, request.headers["if-none-match"], [
        "count",
        userId,
        taxa,
        hideObscure,
        maxDepthM,
      ]);
      if (version.notModified) return reply.code(304).send();

      const res = await version.client
        .query<{ total: string; collected: string; seen: string }>(collectionCountSql(maxDepthM), [
          userId,
          taxa,
          hideObscure,
        ])
        .finally(() => version.release());
      const row = res.rows[0];
      return { total: Number(row.total), collected: Number(row.collected), seen: Number(row.seen) };
    },
  );

  // Totals collected by tier, by family and by year.
  app.get("/collection/stats", { preValidation: requireAuth, schema: {} }, async (request) => {
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

    const byTier: Record<string, number> = { common: 0, occasional: 0, uncommon: 0, rare: 0, legendary: 0, unrated: 0 };
    for (const row of byTierRes.rows) byTier[row.tier] = row.count;

    return {
      totalCollected: totalRes.rows[0].total,
      byTier,
      byFamily: byFamilyRes.rows.map((r) => ({ family: r.family ?? "Unknown", count: r.count })),
      byYear: byYearRes.rows.map((r) => ({ year: r.year, count: r.count })),
    };
  });

  app.patch(
    "/species/:id/cover",
    {
      preValidation: requireAuth,
      config: speciesNotFound,
      schema: {
        params: IdParams,
        // null un-features the species (the Gallery's featured toggle).
        body: Type.Object({ photoId: Nullable(Uuid()) }, { additionalProperties: false }),
        response: replies(Ok),
      },
    },
    async (request, reply) => {
      const { id: speciesId } = request.params;
      const { photoId } = request.body;
      const userId = request.user!.id;

      // Resolve the old cover before overwriting cover_photo_id, to re-sync its sidecar.
      const priorRes = await pool.query<{ cover_photo_id: string | null }>(
        `SELECT cover_photo_id FROM user_species WHERE user_id = $1 AND species_id = $2`,
        [userId, speciesId],
      );
      const priorCoverPhotoId = priorRes.rows[0]?.cover_photo_id ?? null;

      // photoId: null un-features the species (the Gallery's featured toggle).
      if (photoId === null) {
        await pool.query(
          `UPDATE user_species SET cover_photo_id = NULL, card_crop_x = NULL, card_crop_y = NULL, card_crop_size = NULL
           WHERE user_id = $1 AND species_id = $2`,
          [userId, speciesId],
        );
        await syncCoverCaptureXmp(userId, priorCoverPhotoId);
        return { ok: true };
      }
      // Confirm this photo belongs to a capture the user owns, for this species.
      const ownershipRes = await pool.query<{ capture_id: string; display_path: string | null }>(
        `SELECT c.id AS capture_id, p.display_path FROM photos p
         JOIN captures c ON c.id = p.capture_id
         WHERE p.id = $1 AND c.user_id = $2 AND c.species_id = $3`,
        [photoId, userId, speciesId],
      );
      if (ownershipRes.rows.length === 0) {
        return reply.code(403).send({ error: "That photo doesn't belong to you for this species" });
      }

      // The saved crop was framed for the old cover, so clear it and try an automatic crop centered
      // on the subject. A detection miss leaves the plain center crop.
      const displayPath = ownershipRes.rows[0].display_path;
      const defaultCrop = displayPath
        ? await readFile(displayPath)
            .then((buf) => detectDefaultCardCrop(buf, { priority: "interactive" }))
            .catch(() => null)
        : null;
      await pool.query(
        `UPDATE user_species SET cover_photo_id = $1, card_crop_x = $2, card_crop_y = $3, card_crop_size = $4
         WHERE user_id = $5 AND species_id = $6`,
        [photoId, defaultCrop?.x ?? null, defaultCrop?.y ?? null, defaultCrop?.size ?? null, userId, speciesId],
      );
      await syncCoverCaptureXmp(userId, priorCoverPhotoId);
      await syncCaptureXmpSidecarsLogged(userId, ownershipRes.rows[0].capture_id);
      return { ok: true };
    },
  );

  app.patch(
    "/species/:id/card-crop",
    {
      preValidation: requireAuth,
      config: speciesNotFound,
      schema: {
        params: IdParams,
        // Either `reset: true`, or all of x, y and size (checked below, since reset makes them optional).
        body: Type.Object(
          {
            x: Type.Optional(Percent),
            y: Type.Optional(Percent),
            size: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 100 })),
            reset: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
        response: replies(Ok),
      },
    },
    async (request, reply) => {
      const { id: speciesId } = request.params;
      const { x, y, size, reset } = request.body;
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

      if (!isValidCrop(x, y, size)) {
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
