import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { MEDIA_CACHE_BUST } from "@lifer/core/config.js";
import { requireAuth } from "../auth/session.js";
import { getObscurityPreferences } from "../species/obscurity.js";
import { BEST_PHOTO_ORDER } from "../lib/bestPhotoOrder.js";
import { Nullable, Open, Uuid, replies, withSchemas } from "../lib/schema.js";
import { ALREADY_OWNED_SQL } from "../species/obscurity.js";
import { capturedInTreeSql, regionTreeCte } from "../regions/checklist.js";
import { userAddedInTreeSql } from "../regions/checklistAdditions.js";
import { ensureRegionRollup, regionRollupFresh } from "../regions/rollup.js";
import { COLLECTION_WHERE, UNLOCKED_SPECIES_CTE, collectionVersion } from "./routes.js";
import { NotModified } from "./responses.js";

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
  /** Species on your targets, and seen but not photographed, under this node (0 or 1 on a species). */
  targetCount: number;
  seenCount: number;
  /** Species per rarity tier under this node: the region's local tier where it has one, else the
   *  species' own. Only tiers present are listed. */
  tiers: Record<string, number>;
  photoId: string | null;
  /** Species leaves only, so the explorer links to the species and names it by preference. */
  speciesId?: string;
  commonName?: string | null;
  tier?: string | null;
  /** Nothing photographed yet: the catalogue picture of the species, or for a group one of its
   *  common species, shown faded. */
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
  targetCount: Type.Integer({ description: "Species on your targets under this node; 1 or 0 on a species" }),
  seenCount: Type.Integer({
    description: "Species marked seen (not photographed) under this node; 1 or 0 on a species",
  }),
  tiers: Type.Record(Type.String(), Type.Integer(), {
    description: "Species per rarity tier under this node; with a region, its local tier where it has one",
  }),
  photoId: Nullable(Type.String()),
  speciesId: Type.Optional(Type.String()),
  commonName: Type.Optional(Nullable(Type.String())),
  tier: Type.Optional(Nullable(Type.String({ description: "Species leaves: the rarity tier" }))),
  referenceUrl: Type.Optional(
    Nullable(
      Type.String({
        description:
          "Nothing photographed yet: the species' catalogue picture, or for a group (or one whose photos are missing) a representative species' picture",
      }),
    ),
  ),
  children: Type.Array(Type.Unknown()),
});
const TreeResponse = Open({ collected: Type.Integer(), tree: Type.Array(TreeNodeSchema) });
const TreeQuery = Type.Object({
  format: Type.Optional(Type.Literal("csv")),
  include: Type.Optional(
    Type.Literal("uncollected", { description: "Also list the catalogue species not photographed yet" }),
  ),
  regionId: Type.Optional(
    Uuid({ description: "Only the species of this region's checklist (and the ones inside it)" }),
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
  is_target: boolean;
  is_seen: boolean;
  tier: string | null;
  rarity: string | null;
  reference_photo: string | null;
  has_reference_thumb: boolean;
  first_photographed: Date | null;
  best_photo_id: string | null;
  best_rating: number | null;
  best_taken_at: Date | null;
}

// Same species set as GET /collection (its CTE, WHERE and joins); collected is state = 'collected',
// as GET /collection/count counts it. Photos are visible captures (the `captures` view hides trash);
// the best one uses the shared order. It starts from the few species COLLECTION_WHERE can keep
// rather than scanning the whole catalogue. With a region ($4), only the species on its checklist
// or one inside it (vagrant listings left out), or that you photographed or added there, less those
// you hid there. The ones
// inside it are looked up per candidate in region_species_rollup, or while that's being rebuilt
// read from every row of the region's subtree, which is correct but takes seconds for a continent.
type RegionSource = "rollup" | "subtree" | null;
const treeSql = (maxDepthM: number, region: RegionSource) => `WITH RECURSIVE ${
  region ? `${regionTreeCte("region_tree", "$4::uuid")},` : ""
}
  ${UNLOCKED_SPECIES_CTE},
  candidates AS (
    SELECT species_id FROM unlocked
    UNION SELECT species_id FROM user_species WHERE user_id = $1
    UNION SELECT species_id FROM region_species_user_added WHERE user_id = $1
    UNION SELECT species_id FROM sea_zone_species_user_added WHERE user_id = $1
  )${
    region
      ? `,
  in_region AS (
    ${
      region === "rollup"
        ? `SELECT species_id FROM candidates c
      WHERE EXISTS (SELECT 1 FROM region_species x WHERE x.region_id = $4 AND x.species_id = c.species_id AND NOT x.is_vagrant)
        OR EXISTS (SELECT 1 FROM region_species_rollup x WHERE x.region_id = $4 AND x.species_id = c.species_id)`
        : "SELECT species_id FROM region_species WHERE region_id IN (SELECT id FROM region_tree) AND NOT is_vagrant"
    }
    UNION ${capturedInTreeSql("$1", "true")}
    UNION ${userAddedInTreeSql("$1")}
  )`
      : ""
  }
  SELECT s.id AS species_id, s.scientific_name, s.common_name, s.taxon_class, s.taxon_order, s.family,
    COALESCE(us.state = 'collected', false) AS is_collected,
    COALESCE(us.is_target, false) AS is_target, COALESCE(us.state = 'seen', false) AS is_seen,
    COALESCE(uto.tier, r.tier) AS tier,
    ${region ? "COALESCE(lrs.local_tier, uto.tier, r.tier)" : "COALESCE(uto.tier, r.tier)"} AS rarity,
    s.reference_photo, s.reference_thumb_path IS NOT NULL AS has_reference_thumb,
    CASE WHEN us.state = 'collected'
      THEN (SELECT count(*)::int FROM captures c WHERE c.user_id = $1 AND c.species_id = s.id) ELSE 0 END AS photos,
    us.first_collected AS first_photographed,
    best.photo_id AS best_photo_id, best.quality_rating AS best_rating, best.taken_at AS best_taken_at
  FROM candidates cand
  ${region ? "JOIN in_region ir ON ir.species_id = cand.species_id" : ""}
  JOIN species s ON s.id = cand.species_id
  LEFT JOIN species_traits t ON t.species_id = s.id
  LEFT JOIN species_rarity r ON r.species_id = s.id
  LEFT JOIN user_tier_overrides uto ON uto.user_id = $1 AND uto.species_id = s.id AND uto.region_id IS NULL
  LEFT JOIN user_species us ON us.user_id = $1 AND us.species_id = s.id
  ${region ? "LEFT JOIN region_species lrs ON lrs.region_id = $4 AND lrs.species_id = s.id" : ""}
  LEFT JOIN user_archived_species uas ON uas.user_id = $1 AND uas.species_id = s.id
  LEFT JOIN LATERAL (
    SELECT c.current_photo_id AS photo_id, c.quality_rating, c.taken_at FROM captures c
    WHERE us.state = 'collected' AND c.user_id = $1 AND c.species_id = s.id AND c.current_photo_id IS NOT NULL
    ORDER BY ${BEST_PHOTO_ORDER} LIMIT 1
  ) best ON true
  ${COLLECTION_WHERE(maxDepthM)}
    ${
      region
        ? `AND (${ALREADY_OWNED_SQL} OR NOT EXISTS (SELECT 1 FROM region_species_hidden h
        WHERE h.user_id = $1 AND h.species_id = s.id AND h.region_id = $4))`
        : ""
    }
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
        node = {
          rank: RANKS[i],
          name,
          collected: 0,
          total: 0,
          photos: 0,
          targetCount: 0,
          seenCount: 0,
          tiers: {},
          photoId: null,
          children: [],
        };
        if (i === names.length - 1)
          Object.assign(node, {
            speciesId: row.species_id,
            commonName: row.common_name,
            tier: row.tier,
            referenceUrl: row.best_photo_id
              ? null
              : row.has_reference_thumb
                ? `/api/species/${row.species_id}/reference-photo/thumb?v=${MEDIA_CACHE_BUST}`
                : row.reference_photo,
          });
        level.push(node);
      }
      node.total++;
      if (row.is_target) node.targetCount++;
      if (row.is_seen) node.seenCount++;
      const tier = row.rarity ?? "unrated";
      node.tiers[tier] = (node.tiers[tier] ?? 0) + 1;
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
  pickGroupPictures(roots, rows);
  if (includeUncollected) return roots;
  const collectedOnly = (nodes: TreeNode[]): TreeNode[] =>
    nodes.filter((n) => n.collected > 0).map((n) => ({ ...n, children: collectedOnly(n.children) }));
  return collectedOnly(roots);
}

// Most common first, so a group's picture is one you'd recognise it by.
const COMMONEST_FIRST = ["common", "occasional", "uncommon", "rare", "legendary"];
const commonness = (tier: string | null | undefined) => {
  const i = COMMONEST_FIRST.indexOf(tier ?? "");
  return i < 0 ? COMMONEST_FIRST.length : i;
};
const PICKS = 5; // one more than the ranks above a genus, so a level can always differ from its parents

/** Gives every group without a photo of yours the catalogue picture of a common species inside it,
 *  a different species from the groups above it where one exists, so no row draws blank (S4). */
function pickGroupPictures(roots: TreeNode[], rows: Row[]): void {
  const urlOf = new Map<string, string>();
  for (const r of rows) {
    const url = r.has_reference_thumb
      ? `/api/species/${r.species_id}/reference-photo/thumb?v=${MEDIA_CACHE_BUST}`
      : r.reference_photo;
    if (url) urlOf.set(r.species_id, url);
  }
  // The few best candidates per node, bottom up, so a 15,000-species tree stays linear.
  const candidates = new Map<TreeNode, TreeNode[]>();
  const gather = (node: TreeNode): TreeNode[] => {
    const found =
      node.rank === "species"
        ? node.speciesId && urlOf.has(node.speciesId)
          ? [node]
          : []
        : node.children
            .flatMap(gather)
            .sort((a, b) => commonness(a.tier) - commonness(b.tier) || a.name.localeCompare(b.name))
            .slice(0, PICKS);
    candidates.set(node, found);
    return found;
  };
  roots.forEach(gather);
  const assign = (node: TreeNode, used: Set<TreeNode>) => {
    if (node.rank === "species") return;
    const options = candidates.get(node)!;
    const pick = options.find((c) => !used.has(c)) ?? options[0];
    if (!node.photoId && pick) node.referenceUrl = urlOf.get(pick.speciesId!)!;
    const below = !node.photoId && pick ? new Set(used).add(pick) : used;
    for (const child of node.children) assign(child, below);
  };
  for (const root of roots) assign(root, new Set());
}

// The last few trees as sent, by ETag, for a client without its own copy (another window, or one
// it let go of). A tree can be 15 MB, so few and bounded by size; the ETag changes with any write.
const KEPT_TREES_MAX_BYTES = 64_000_000;
const builtTrees = new Map<string, string>();

function keepTree(etag: string, body: string): void {
  builtTrees.delete(etag);
  builtTrees.set(etag, body);
  let size = 0;
  for (const kept of builtTrees.values()) size += kept.length;
  for (const [key, kept] of builtTrees) {
    if (size <= KEPT_TREES_MAX_BYTES || builtTrees.size === 1) break;
    builtTrees.delete(key);
    size -= kept.length;
  }
}

/** Test hook: forget the kept trees. */
export function clearBuiltTrees(): void {
  builtTrees.clear();
}

export async function collectionTreeRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  // The user's collected species as a taxonomy tree, or ?format=csv for a spreadsheet.
  app.get(
    "/collection/tree",
    {
      preValidation: requireAuth,
      schema: { querystring: TreeQuery, response: { ...replies(TreeResponse), 304: NotModified } },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const { hideObscure, maxDepthM } = await getObscurityPreferences(userId);
      const { regionId } = request.query;
      const csv = request.query.format === "csv";
      let source: RegionSource = null;
      if (regionId) {
        source = (await regionRollupFresh()) ? "rollup" : "subtree";
        if (source === "subtree") void ensureRegionRollup();
      }
      // The JSON tree shares GET /collection's ETag, so switching back to a region costs a 304.
      const version = csv
        ? null
        : await collectionVersion(reply, request.headers["if-none-match"], [
            "tree",
            userId,
            regionId ?? null,
            request.query.include ?? null,
            hideObscure,
            maxDepthM,
          ]);
      if (version?.notModified) return reply.code(304).send();
      const etag = reply.getHeader("etag") as string | undefined;
      const kept = etag ? builtTrees.get(etag) : undefined;
      if (version && kept) {
        version.release();
        keepTree(etag!, kept);
        return reply.type("application/json").send(kept as never);
      }
      const params = regionId ? [userId, null, hideObscure, regionId] : [userId, null, hideObscure];
      const { rows } = await (version
        ? version.client.query<Row>(treeSql(maxDepthM, source), params).finally(() => version.release())
        : pool.query<Row>(treeSql(maxDepthM, source), params));
      const collectedRows = rows.filter((r) => r.is_collected);

      if (csv) {
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
      const body = JSON.stringify({
        collected: collectedRows.length,
        tree: buildTree(rows, request.query.include === "uncollected"),
      });
      if (etag) keepTree(etag, body);
      return reply.type("application/json").send(body as never);
    },
  );
}
