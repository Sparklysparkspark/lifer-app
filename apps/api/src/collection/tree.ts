import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { MEDIA_CACHE_BUST } from "@lifer/core/config.js";
import { requireAuth } from "../auth/session.js";
import { getObscurityPreferences } from "../species/obscurity.js";
import { BEST_PHOTO_ORDER } from "../lib/bestPhotoOrder.js";
import { Nullable, Open, replies, withSchemas } from "../lib/schema.js";
import { COLLECTION_WHERE, UNLOCKED_SPECIES_CTE } from "./routes.js";

const OTHER = "Other";
const RANKS = ["class", "order", "family", "genus", "species"] as const;
type Rank = (typeof RANKS)[number];

interface TreeNode {
  rank: Rank;
  name: string;
  collected: number;
  /** Species in the catalogue (your downloaded regions and additions) under this node. */
  total: number;
  /** Your photos under this node. */
  photos: number;
  photoId: string | null;
  /** Species leaves only, so the explorer links to the species and names it by preference. */
  speciesId?: string;
  commonName?: string | null;
  tier?: string | null;
  /** A species not photographed yet: its catalogue picture, shown faded. */
  referenceUrl?: string | null;
  children: TreeNode[];
}

// Children are the same node shape one rank down; typebox here has no recursive type, so they are listed as open.
const TreeNodeSchema = Open({
  rank: Type.String({ description: RANKS.join(" | ") }),
  name: Type.String(),
  collected: Type.Integer(),
  total: Type.Integer({ description: "Catalogue species under this node, photographed or not" }),
  photos: Type.Integer({ description: "Your photos under this node" }),
  photoId: Nullable(Type.String()),
  speciesId: Type.Optional(Type.String()),
  commonName: Type.Optional(Nullable(Type.String())),
  tier: Type.Optional(Nullable(Type.String({ description: "Species leaves: the rarity tier" }))),
  referenceUrl: Type.Optional(
    Nullable(Type.String({ description: "Species not photographed yet: the catalogue picture's URL" })),
  ),
  children: Type.Array(Type.Unknown()),
});
const TreeResponse = Open({ collected: Type.Integer(), tree: Type.Array(TreeNodeSchema) });
const TreeQuery = Type.Object({
  format: Type.Optional(Type.Literal("csv")),
  include: Type.Optional(
    Type.Literal("uncollected", { description: "Also list the catalogue species not photographed yet" }),
  ),
});

interface Row {
  species_id: string;
  scientific_name: string;
  common_name: string | null;
  taxon_class: string | null;
  taxon_order: string | null;
  family: string | null;
  photos: number;
  is_collected: boolean;
  tier: string | null;
  reference_photo: string | null;
  has_reference_thumb: boolean;
  first_photographed: Date | null;
  best_photo_id: string | null;
  best_rating: number | null;
  best_taken_at: Date | null;
}

// Same species set as GET /collection (its CTE, WHERE and joins); collected is state = 'collected',
// as GET /collection/count counts it. Photos are visible captures (the `captures` view hides trash);
// the best one uses the shared order.
const treeSql = (maxDepthM: number) => `WITH ${UNLOCKED_SPECIES_CTE}
  SELECT s.id AS species_id, s.scientific_name, s.common_name, s.taxon_class, s.taxon_order, s.family,
    COALESCE(us.state = 'collected', false) AS is_collected,
    COALESCE(uto.tier, r.tier) AS tier,
    s.reference_photo, s.reference_thumb_path IS NOT NULL AS has_reference_thumb,
    CASE WHEN us.state = 'collected'
      THEN (SELECT count(*)::int FROM captures c WHERE c.user_id = $1 AND c.species_id = s.id) ELSE 0 END AS photos,
    us.first_collected AS first_photographed,
    best.photo_id AS best_photo_id, best.quality_rating AS best_rating, best.taken_at AS best_taken_at
  FROM species s
  LEFT JOIN species_traits t ON t.species_id = s.id
  LEFT JOIN species_rarity r ON r.species_id = s.id
  LEFT JOIN user_tier_overrides uto ON uto.user_id = $1 AND uto.species_id = s.id AND uto.region_id IS NULL
  LEFT JOIN user_species us ON us.user_id = $1 AND us.species_id = s.id
  LEFT JOIN user_archived_species uas ON uas.user_id = $1 AND uas.species_id = s.id
  LEFT JOIN LATERAL (
    SELECT c.current_photo_id AS photo_id, c.quality_rating, c.taken_at FROM captures c
    WHERE us.state = 'collected' AND c.user_id = $1 AND c.species_id = s.id AND c.current_photo_id IS NOT NULL
    ORDER BY ${BEST_PHOTO_ORDER} LIMIT 1
  ) best ON true
  ${COLLECTION_WHERE(maxDepthM)}
  ORDER BY s.scientific_name`;

const csvField = (v: string | number | Date | null): string => {
  if (v == null) return "";
  const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Builds class > order > family > genus > species; a missing order or family groups under "Other".
 *  Every row counts toward `total`; only collected ones toward `collected`, `photos` and the photo.
 *  Without `includeUncollected`, branches with nothing collected are left out. */
export function buildTree(rows: Row[], includeUncollected = false): TreeNode[] {
  const roots: TreeNode[] = [];
  // Best photo so far per node: higher rating, then newer.
  const best = new Map<TreeNode, Row>();
  const beats = (a: Row, b: Row) =>
    (a.best_rating ?? -1) !== (b.best_rating ?? -1)
      ? (a.best_rating ?? -1) > (b.best_rating ?? -1)
      : (a.best_taken_at?.getTime() ?? 0) > (b.best_taken_at?.getTime() ?? 0);
  for (const row of rows) {
    const names = [
      row.taxon_class || OTHER,
      row.taxon_order || OTHER,
      row.family || OTHER,
      row.scientific_name.split(" ")[0] || OTHER,
      row.scientific_name,
    ];
    let level = roots;
    names.forEach((name, i) => {
      let node = level.find((n) => n.name === name);
      if (!node) {
        node = { rank: RANKS[i], name, collected: 0, total: 0, photos: 0, photoId: null, children: [] };
        if (i === names.length - 1)
          Object.assign(node, {
            speciesId: row.species_id,
            commonName: row.common_name,
            tier: row.tier,
            referenceUrl: row.is_collected
              ? null
              : row.has_reference_thumb
                ? `/api/species/${row.species_id}/reference-photo/thumb?v=${MEDIA_CACHE_BUST}`
                : row.reference_photo,
          });
        level.push(node);
      }
      node.total++;
      if (!row.is_collected) {
        level = node.children;
        return;
      }
      node.collected++;
      node.photos += row.photos;
      const cur = best.get(node);
      if (row.best_photo_id && (!cur || beats(row, cur))) {
        best.set(node, row);
        node.photoId = row.best_photo_id;
      }
      level = node.children;
    });
  }
  if (includeUncollected) return roots;
  const collectedOnly = (nodes: TreeNode[]): TreeNode[] =>
    nodes.filter((n) => n.collected > 0).map((n) => ({ ...n, children: collectedOnly(n.children) }));
  return collectedOnly(roots);
}

export async function collectionTreeRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  // The user's collected species as a taxonomy tree, or ?format=csv for a spreadsheet.
  app.get(
    "/collection/tree",
    { preValidation: requireAuth, schema: { querystring: TreeQuery, response: replies(TreeResponse) } },
    async (request, reply) => {
      const userId = request.user!.id;
      const { hideObscure, maxDepthM } = await getObscurityPreferences(userId);
      const { rows } = await pool.query<Row>(treeSql(maxDepthM), [userId, null, hideObscure]);
      const collectedRows = rows.filter((r) => r.is_collected);

      if (request.query.format === "csv") {
        const lines = [
          "class,order,family,genus,scientific name,common name,photos,first photographed",
          ...collectedRows.map((r) =>
            [
              r.taxon_class || OTHER,
              r.taxon_order || OTHER,
              r.family || OTHER,
              r.scientific_name.split(" ")[0],
              r.scientific_name,
              r.common_name,
              r.photos,
              r.first_photographed,
            ]
              .map(csvField)
              .join(","),
          ),
        ];
        reply.header("Content-Type", "text/csv; charset=utf-8");
        reply.header("Content-Disposition", 'attachment; filename="lifer-collection.csv"');
        // The route's JSON response schema doesn't apply to a string body sent raw.
        return reply.send(lines.join("\n") as never);
      }
      return { collected: collectedRows.length, tree: buildTree(rows, request.query.include === "uncollected") };
    },
  );
}
