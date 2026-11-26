// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// GET /collection/tree: totals match /collection/count, hand-added species group under Other, CSV export,
// and the region filter through region_species_rollup, which checklist changes invalidate, plus
// the region's nearby sea zones.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000b01";
const SP_A = "eeeeeeee-0000-4000-8000-000000000b0a";
const SP_B = "eeeeeeee-0000-4000-8000-000000000b0b";
// Seen, not photographed: in the catalogue without a downloaded region.
const SP_C = "eeeeeeee-0000-4000-8000-000000000b0c";
// A seen-only order, so its groups have no photo of yours.
const SP_D = "eeeeeeee-0000-4000-8000-000000000b0d";
const SP_E = "eeeeeeee-0000-4000-8000-000000000b0e";
// Listed by a downloaded pack's province, and added to a province by hand.
const SP_F = "eeeeeeee-0000-4000-8000-000000000b0f";
const SP_G = "eeeeeeee-0000-4000-8000-000000000b10";
// Listed only on the country's nearby sea zone.
const SP_H = "eeeeeeee-0000-4000-8000-000000000b11";
const ZONE = "eeeeeeee-0000-4000-8000-000000000b1d";
const PACK = "zztree-pack";
const SEA_PACK = "zztree-sea-pack";
const TOKEN = "lifer_test_collection_tree_b01";
const COUNTRY = "eeeeeeee-0000-4000-8000-000000000b1a";
const PROVINCE = "eeeeeeee-0000-4000-8000-000000000b1b";
// With no checklist of its own, so its species come only from the rollup.
const CONTINENT = "eeeeeeee-0000-4000-8000-000000000b1c";
// A continent-sized checklist: more species than fit in work_mem below.
const BIG = 20000;
const BIG_GBIF = 92090000;

describe.skipIf(!url)("collection tree", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;
  let ensureRegionRollup: () => Promise<void>;
  let regionRollupFresh: () => Promise<boolean>;

  const get = (route: string) => app.inject({ method: "GET", url: route, cookies: { [cookieName]: TOKEN } });

  async function cleanup() {
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM downloaded_packs WHERE pack_id = ANY($1)`, [[PACK, SEA_PACK]]);
    await db.query(`DELETE FROM sea_zones WHERE id = $1`, [ZONE]);
    await db.query(`DELETE FROM species_rarity WHERE species_id = $1`, [SP_H]);
    await db.query(`DELETE FROM region_species WHERE region_id = ANY($1)`, [[COUNTRY, PROVINCE]]);
    await db.query(`DELETE FROM region_species_rollup WHERE region_id = ANY($1)`, [[CONTINENT, COUNTRY, PROVINCE]]);
    await db.query(`DELETE FROM regions WHERE id = ANY($1)`, [[PROVINCE, COUNTRY, CONTINENT]]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[SP_A, SP_B, SP_C, SP_D, SP_E, SP_F, SP_G, SP_H]]);
    await db.query(`DELETE FROM species WHERE gbif_key >= $1 AND gbif_key < $1 + $2`, [BIG_GBIF, BIG]);
  }

  beforeAll(async () => {
    // A tiny work_mem stands in for a full catalogue outgrowing the default; the timeout turns a
    // runaway region query into a failure instead of a hang.
    process.env.DATABASE_URL = `${url}${url!.includes("?") ? "&" : "?"}options=-c%20work_mem%3D64kB%20-c%20statement_timeout%3D5000`;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { collectionRoutes } = await import("./routes.js");
    const { collectionTreeRoutes } = await import("./tree.js");
    const { collectionBulkRoutes } = await import("./bulk.js");
    ({ ensureRegionRollup, regionRollupFresh } = await import("../regions/rollup.js"));

    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'tree@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class, taxon_order, family) VALUES
         ($1, 920801, 'Treeus alphus', 'Alpha, Tree Bird', 'aves', 'Passeriformes', 'Treeidae'),
         ($2, 920802, 'Handus addedus', 'Hand Bird', 'aves', NULL, NULL),
         ($3, 920803, 'Treeus betus', 'Beta Tree Bird', 'aves', 'Passeriformes', 'Treeidae'),
         ($4, 920804, 'Rootus deltus', 'Delta Root Bird', 'aves', 'Rootiformes', 'Rootidae'),
         ($5, 920805, 'Rootus epsilon', 'Epsilon Root Bird', 'aves', 'Rootiformes', 'Rootidae'),
         ($6, 920806, 'Packus newus', 'Pack Bird', 'aves', 'Packiformes', 'Packidae'),
         ($7, 920807, 'Handus secundus', 'Second Hand Bird', 'aves', NULL, NULL)`,
      [SP_A, SP_B, SP_C, SP_D, SP_E, SP_F, SP_G],
    );
    await db.query(
      `UPDATE species SET reference_photo = 'https://example.org/' || gbif_key || '.jpg', reference_credit = 'x', reference_license = 'cc-by' WHERE id = ANY($1)`,
      [[SP_A, SP_B, SP_C, SP_D, SP_E, SP_F, SP_G]],
    );
    for (const sp of [SP_C, SP_D, SP_E])
      await db.query(`INSERT INTO user_species (user_id, species_id, state) VALUES ($1, $2, 'seen')`, [USER, sp]);
    // A continent holding a country listing Alpha and Beta, with a province inside it where Hand
    // Bird was photographed. The country code makes the province part of the country's pack.
    await db.query(
      `INSERT INTO regions (id, name, parent_id, external_codes) VALUES
         ($3, 'Zztree continent', NULL, '{}'), ($1, 'Zztree country', $3, '{ZZ}'), ($2, 'Zztree province', $1, '{}')`,
      [COUNTRY, PROVINCE, CONTINENT],
    );
    await db.query(`INSERT INTO region_species (region_id, species_id) VALUES ($1, $2), ($1, $3)`, [
      COUNTRY,
      SP_A,
      SP_C,
    ]);
    for (const sp of [SP_A, SP_B]) {
      const c = await db.query<{ id: string }>(
        `INSERT INTO captures (user_id, species_id, fingerprint, taken_at, region_id) VALUES ($1, $2, $3, now(), $4) RETURNING id`,
        [USER, sp, `tree-${sp}`, sp === SP_B ? PROVINCE : null],
      );
      const p = await db.query<{ id: string }>(
        `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp') RETURNING id`,
        [c.rows[0].id],
      );
      await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
      await db.query(
        `INSERT INTO user_species (user_id, species_id, state, first_collected) VALUES ($1, $2, 'collected', '2024-05-06')`,
        [USER, sp],
      );
    }

    app = Fastify();
    await app.register(cookie);
    await app.register(collectionRoutes, { prefix: "/api" });
    await app.register(collectionTreeRoutes, { prefix: "/api" });
    await app.register(collectionBulkRoutes, { prefix: "/api" });
    await app.ready();
  });

  // Deleting the 20,000-species checklist takes more than the default 10s on a busy machine.
  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  }, 60000);

  it("totals equal the collection count and species with no family or order land under Other", async () => {
    const count = (await get("/api/collection/count")).json();
    const res = await get("/api/collection/tree");
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.collected).toBe(count.collected);
    expect(body.tree.reduce((n: number, c: { collected: number }) => n + c.collected, 0)).toBe(count.collected);

    const aves = body.tree.find((n: { name: string }) => n.name === "aves");
    expect(aves.rank).toBe("class");
    const other = aves.children.find((n: { name: string }) => n.name === "Other");
    expect(other.rank).toBe("order");
    expect(other.children[0].name).toBe("Other");
    expect(other.children[0].children[0]).toMatchObject({ rank: "genus", name: "Handus", collected: 1 });
    const family = aves.children.find((n: { name: string }) => n.name === "Passeriformes").children[0];
    expect(family).toMatchObject({ rank: "family", name: "Treeidae", collected: 1 });
    expect(family.photoId).toEqual(expect.any(String));
  });

  it("counts the catalogue in every node, and lists species not photographed yet on request", async () => {
    const family = (body: { tree: Array<{ name: string; children: Array<{ name: string; children: unknown[] }> }> }) =>
      body.tree.find((n) => n.name === "aves")!.children.find((n) => n.name === "Passeriformes")!
        .children[0] as unknown as {
        total: number;
        collected: number;
        photos: number;
        children: Array<{ children: Array<Record<string, unknown>> }>;
      };

    const plain = family((await get("/api/collection/tree")).json());
    expect([plain.collected, plain.total, plain.photos]).toEqual([1, 2, 1]);
    expect(plain.children[0].children.map((s) => s.name)).toEqual(["Treeus alphus"]);

    const all = (await get("/api/collection/tree?include=uncollected")).json();
    expect(all.collected).toBe((await get("/api/collection/count")).json().collected);
    const leaves = family(all).children[0].children;
    expect(leaves.map((s) => [s.name, s.collected, s.photoId === null])).toEqual([
      ["Treeus alphus", 1, false],
      ["Treeus betus", 0, true],
    ]);
    expect(leaves[1]).toMatchObject({ speciesId: SP_C, total: 1, photos: 0 });
  });

  it("counts targets and seen species in every node, and on each species", async () => {
    type N = { name: string; targetCount: number; seenCount: number; children: N[] };
    await db.query(`UPDATE user_species SET is_target = true WHERE user_id = $1 AND species_id = ANY($2)`, [
      USER,
      [SP_A, SP_C],
    ]);
    try {
      const tree: N[] = (await get("/api/collection/tree?include=uncollected")).json().tree;
      const aves = tree.find((n) => n.name === "aves")!;
      // Seen: Beta, Delta and Epsilon; targets: Alpha (photographed) and Beta.
      expect([aves.targetCount, aves.seenCount]).toEqual([2, 3]);
      const family = aves.children.find((n) => n.name === "Passeriformes")!.children[0];
      expect([family.targetCount, family.seenCount]).toEqual([2, 1]);
      const counts = Object.fromEntries(family.children[0].children.map((s) => [s.name, [s.targetCount, s.seenCount]]));
      expect(counts).toEqual({ "Treeus alphus": [1, 0], "Treeus betus": [1, 1] });
    } finally {
      await db.query(`UPDATE user_species SET is_target = false WHERE user_id = $1`, [USER]);
    }
  });

  it("tallies rarity per node: the region's local tier where it has one, else the species' own", async () => {
    type N = { name: string; tiers: Record<string, number>; children: N[] };
    await db.query(
      `INSERT INTO species_rarity (species_id, range_score, abundance_score, composite, tier)
       VALUES ($1, 0, 0, 0, 'common'), ($2, 0, 0, 0, 'uncommon')`,
      [SP_A, SP_C],
    );
    await db.query(`UPDATE region_species SET local_tier = 'rare' WHERE region_id = $1 AND species_id = $2`, [
      COUNTRY,
      SP_A,
    ]);
    try {
      const family = async (q: string) =>
        ((await get(`/api/collection/tree?include=uncollected${q}`)).json().tree as N[])
          .find((n) => n.name === "aves")!
          .children.find((n) => n.name === "Passeriformes")!.children[0];
      expect((await family("")).tiers).toEqual({ common: 1, uncommon: 1 });
      const local = await family(`&regionId=${COUNTRY}`);
      expect(local.tiers).toEqual({ rare: 1, uncommon: 1 });
      expect(local.children[0].children.find((s) => s.name === "Treeus alphus")!.tiers).toEqual({ rare: 1 });
    } finally {
      await db.query(`DELETE FROM species_rarity WHERE species_id = ANY($1)`, [[SP_A, SP_C]]);
      await db.query(`UPDATE region_species SET local_tier = NULL WHERE region_id = $1`, [COUNTRY]);
    }
  });

  it("gives every node a picture, groups with no photo a faded species picture differing from the group above", async () => {
    type N = { rank: string; name: string; photoId: string | null; referenceUrl?: string | null; children: N[] };
    const tree: N[] = (await get("/api/collection/tree?include=uncollected")).json().tree;
    const walk = (nodes: N[]): N[] => nodes.flatMap((n) => [n, ...walk(n.children)]);
    for (const n of walk(tree)) expect(n.photoId ?? n.referenceUrl, `${n.rank} ${n.name}`).toBeTruthy();
    const order = tree.find((n) => n.name === "aves")!.children.find((n) => n.name === "Rootiformes")!;
    const family = order.children[0];
    expect(order.photoId).toBeNull();
    expect(order.referenceUrl).toMatch(/^https:\/\/example\.org\/92080[45]\.jpg$/);
    expect(family.referenceUrl).toMatch(/^https:\/\/example\.org\/92080[45]\.jpg$/);
    expect(family.referenceUrl).not.toBe(order.referenceUrl);
  });

  it("narrows to a region's checklist and what you photographed inside it, counting relative to it", async () => {
    type N = { name: string; collected: number; total: number; children: N[] };
    const res = await get(`/api/collection/tree?include=uncollected&regionId=${COUNTRY}`);
    expect(res.statusCode, res.body).toBe(200);
    const body: { collected: number; tree: N[] } = res.json();
    const leaves = (nodes: N[]): string[] => nodes.flatMap((n) => (n.children.length ? leaves(n.children) : [n.name]));
    expect(leaves(body.tree).sort()).toEqual(["Handus addedus", "Treeus alphus", "Treeus betus"]);
    expect(body.collected).toBe(2);
    const aves = body.tree.find((n) => n.name === "aves")!;
    expect([aves.collected, aves.total]).toEqual([2, 3]);
    expect(aves.children.map((n) => n.name)).not.toContain("Rootiformes");

    const province = (await get(`/api/collection/tree?include=uncollected&regionId=${PROVINCE}`)).json();
    expect(leaves(province.tree)).toEqual(["Handus addedus"]);
    expect((await get("/api/collection/tree?regionId=nope")).statusCode).toBe(400);
  });

  it("leaves a vagrant listing out of a region you didn't photograph it in", async () => {
    type N = { name: string; children: N[] };
    const leaves = (nodes: N[]): string[] => nodes.flatMap((n) => (n.children.length ? leaves(n.children) : [n.name]));
    const leavesIn = async (regionId: string) =>
      leaves((await get(`/api/collection/tree?include=uncollected&regionId=${regionId}`)).json().tree);
    // Delta is on your list, seen elsewhere; the province lists it only as a vagrant.
    await db.query(`INSERT INTO region_species (region_id, species_id, is_vagrant) VALUES ($1, $2, true)`, [
      PROVINCE,
      SP_D,
    ]);
    try {
      expect(await leavesIn(PROVINCE)).not.toContain("Rootus deltus");
      await ensureRegionRollup();
      expect(await regionRollupFresh()).toBe(true);
      expect(await leavesIn(CONTINENT)).not.toContain("Rootus deltus");
      expect(await leavesIn(COUNTRY)).not.toContain("Rootus deltus");
    } finally {
      await db.query(`DELETE FROM region_species WHERE region_id = $1 AND species_id = $2`, [PROVINCE, SP_D]);
    }
  });

  it("adds the region's nearby sea zones, once per species, without reviving a vagrant listing", async () => {
    type N = { name: string; tiers: Record<string, number>; children: N[] };
    const leaves = (nodes: N[]): N[] => nodes.flatMap((n) => (n.children.length ? leaves(n.children) : [n]));
    const leavesIn = async (regionId: string) => {
      const res = await get(`/api/collection/tree?include=uncollected&regionId=${regionId}`);
      expect(res.statusCode, res.body).toBe(200);
      return leaves(res.json().tree);
    };
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, taxon_class, taxon_order, family, reference_photo, reference_credit, reference_license)
       VALUES ($1, 920808, 'Marinus solus', 'marine_mollusks', 'Neogastropoda', 'Marinidae', 'https://example.org/m.jpg', 'x', 'cc-by')`,
      [SP_H],
    );
    await db.query(
      `INSERT INTO species_rarity (species_id, range_score, abundance_score, composite, tier) VALUES ($1, 0, 0, 0, 'rare')`,
      [SP_H],
    );
    await db.query(
      `INSERT INTO sea_zones (id, name, wkt, bbox_min_lon, bbox_min_lat, bbox_max_lon, bbox_max_lat) VALUES ($1, 'Zztree sea', 'POINT(0 0)', 0, 0, 0, 0)`,
      [ZONE],
    );
    await db.query(`INSERT INTO downloaded_packs (pack_id, region) VALUES ($1, 'Zztree sea')`, [SEA_PACK]);
    // Alpha is on the country too; Delta (seen) is there only as a vagrant.
    await db.query(
      `INSERT INTO sea_zone_species (sea_zone_id, species_id, record_count) VALUES ($1, $2, 5), ($1, $3, 5), ($1, $4, 5)`,
      [ZONE, SP_H, SP_A, SP_D],
    );
    await db.query(`INSERT INTO region_species (region_id, species_id, is_vagrant) VALUES ($1, $2, true)`, [
      COUNTRY,
      SP_D,
    ]);
    try {
      expect((await leavesIn(COUNTRY)).map((n) => n.name)).not.toContain("Marinus solus");
      await db.query(`UPDATE regions SET nearby_sea_zone_ids = $1 WHERE id = $2`, [[ZONE], COUNTRY]);
      const country = await leavesIn(COUNTRY);
      const names = country.map((n) => n.name);
      expect(names).toContain("Marinus solus");
      expect(names.filter((n) => n === "Treeus alphus")).toHaveLength(1);
      expect(names).not.toContain("Rootus deltus");
      // No local tier on the zone, as on the checklist page: the species' own.
      expect(country.find((n) => n.name === "Marinus solus")!.tiers).toEqual({ rare: 1 });
      expect((await leavesIn(PROVINCE)).map((n) => n.name)).not.toContain("Marinus solus");
    } finally {
      await db.query(`UPDATE regions SET nearby_sea_zone_ids = NULL WHERE id = $1`, [COUNTRY]);
      await db.query(`DELETE FROM region_species WHERE region_id = $1 AND species_id = $2`, [COUNTRY, SP_D]);
      await db.query(`DELETE FROM downloaded_packs WHERE pack_id = $1`, [SEA_PACK]);
      await db.query(`DELETE FROM sea_zones WHERE id = $1`, [ZONE]);
      await db.query(`DELETE FROM species_rarity WHERE species_id = $1`, [SP_H]);
      await db.query(`DELETE FROM species WHERE id = $1`, [SP_H]);
    }
  });

  it("filters by a continent through the rollup, rebuilt after a pack install or removal, with hides and additions at once", async () => {
    type N = { name: string; children: N[] };
    const leaves = (nodes: N[]): string[] => nodes.flatMap((n) => (n.children.length ? leaves(n.children) : [n.name]));
    const leavesIn = async (regionId: string) => {
      const res = await get(`/api/collection/tree?include=uncollected&regionId=${regionId}`);
      expect(res.statusCode, res.body).toBe(200);
      return leaves(res.json().tree).sort();
    };
    await ensureRegionRollup();
    expect(await regionRollupFresh()).toBe(true);
    expect(await leavesIn(CONTINENT)).toEqual(["Handus addedus", "Treeus alphus", "Treeus betus"]);

    // A pack install: the country's pack is downloaded and its province lists a new species.
    await db.query(`INSERT INTO downloaded_packs (pack_id, region) VALUES ($1, 'Zztree country')`, [PACK]);
    await db.query(`INSERT INTO region_species (region_id, species_id) VALUES ($1, $2)`, [PROVINCE, SP_F]);
    expect(await regionRollupFresh()).toBe(false);
    // Read from the subtree until the rebuild lands, then from the rollup: the same answer.
    expect(await leavesIn(CONTINENT)).toContain("Packus newus");
    await ensureRegionRollup();
    expect(await regionRollupFresh()).toBe(true);
    expect(await leavesIn(CONTINENT)).toContain("Packus newus");

    // Hidden on the continent: gone there at once, still on the country, and no rebuild needed.
    await db.query(`INSERT INTO region_species_hidden (user_id, region_id, species_id) VALUES ($1, $2, $3)`, [
      USER,
      CONTINENT,
      SP_F,
    ]);
    expect(await leavesIn(CONTINENT)).not.toContain("Packus newus");
    expect(await leavesIn(COUNTRY)).toContain("Packus newus");
    await db.query(`DELETE FROM region_species_hidden WHERE user_id = $1`, [USER]);

    // Added to the province by hand: on the continent at once.
    await db.query(`INSERT INTO region_species_user_added (user_id, region_id, species_id) VALUES ($1, $2, $3)`, [
      USER,
      PROVINCE,
      SP_G,
    ]);
    expect(await regionRollupFresh()).toBe(true);
    expect(await leavesIn(CONTINENT)).toContain("Handus secundus");
    await db.query(`DELETE FROM region_species_user_added WHERE user_id = $1`, [USER]);

    // The pack removed: its rows go, and the rebuilt rollup drops the species.
    await db.query(`DELETE FROM region_species WHERE region_id = $1 AND species_id = $2`, [PROVINCE, SP_F]);
    await db.query(`DELETE FROM downloaded_packs WHERE pack_id = $1`, [PACK]);
    expect(await regionRollupFresh()).toBe(false);
    await ensureRegionRollup();
    const rollup = await db.query(`SELECT 1 FROM region_species_rollup WHERE region_id = $1 AND species_id = $2`, [
      CONTINENT,
      SP_F,
    ]);
    expect(rollup.rows).toHaveLength(0);
    expect(await leavesIn(CONTINENT)).toEqual(["Handus addedus", "Treeus alphus", "Treeus betus"]);
  });

  it("waits for a checklist write still in flight before stamping the rollup current", async () => {
    const writer = await db.connect();
    try {
      await writer.query("BEGIN");
      await writer.query(`INSERT INTO region_species (region_id, species_id) VALUES ($1, $2)`, [PROVINCE, SP_F]);
      const rebuilt = ensureRegionRollup();
      await new Promise((r) => setTimeout(r, 300));
      await writer.query("COMMIT");
      await rebuilt;
    } finally {
      writer.release();
    }
    expect(await regionRollupFresh()).toBe(true);
    const rollup = await db.query(`SELECT 1 FROM region_species_rollup WHERE region_id = $1 AND species_id = $2`, [
      CONTINENT,
      SP_F,
    ]);
    expect(rollup.rows).toHaveLength(1);
    await db.query(`DELETE FROM region_species WHERE region_id = $1 AND species_id = $2`, [PROVINCE, SP_F]);
  });

  it("answers a region with a checklist larger than work_mem in seconds", async () => {
    await db.query(
      `WITH s AS (
         INSERT INTO species (gbif_key, scientific_name, taxon_class)
         SELECT $1 + g, 'Bigus n' || g, 'aves' FROM generate_series(0, $2 - 1) g RETURNING id)
       INSERT INTO region_species (region_id, species_id) SELECT $3, id FROM s`,
      [BIG_GBIF, BIG, COUNTRY],
    );
    // Fresh statistics, so it is planned as a real catalogue would be.
    await db.query(`ANALYZE region_species, species`);
    const res = await get(`/api/collection/tree?include=uncollected&regionId=${COUNTRY}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().collected).toBe(2);

    // A whole class targeted from the tree is one bulk call, well inside the statement timeout.
    const ids = (
      await db.query<{ id: string }>(`SELECT id FROM species WHERE gbif_key >= $1 AND gbif_key < $1 + $2`, [
        BIG_GBIF,
        BIG,
      ])
    ).rows.map((r) => r.id);
    const post = (action: string, speciesIds: string[]) =>
      app.inject({
        method: "POST",
        url: "/api/collection/bulk",
        cookies: { [cookieName]: TOKEN },
        payload: { action, speciesIds },
      });
    const started = Date.now();
    const targeted = await post("target", ids);
    const took = Date.now() - started;
    expect(targeted.statusCode, targeted.body).toBe(200);
    expect(targeted.json().changedIds).toHaveLength(BIG);
    expect(took).toBeLessThan(5000);
    expect((await post("untarget", targeted.json().changedIds)).json().changedIds).toHaveLength(BIG);
    await db.query(`DELETE FROM user_species WHERE user_id = $1 AND species_id = ANY($2)`, [USER, ids]);
  }, 30000);

  it("exports a CSV with a header, one line per species and escaped commas", async () => {
    const res = await get("/api/collection/tree?format=csv");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("attachment");
    const lines = res.body.split("\n");
    const count = (await get("/api/collection/count")).json();
    expect(lines[0]).toBe("class,order,family,genus,scientific name,common name,photos,first photographed");
    expect(lines.length - 1).toBe(count.collected);
    expect(lines).toContain('aves,Passeriformes,Treeidae,Treeus,Treeus alphus,"Alpha, Tree Bird",1,2024-05-06');
  });

  it("answers 304 to its ETag per region until a target or a hide there changes it", async () => {
    const path = `/api/collection/tree?include=uncollected&regionId=${COUNTRY}`;
    const conditional = (etag: string) =>
      app.inject({ method: "GET", url: path, cookies: { [cookieName]: TOKEN }, headers: { "if-none-match": etag } });
    // The version is database-wide, so a parallel test file can bump it between two requests.
    const settledEtag = async () => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const first = await get(path);
        expect(first.statusCode).toBe(200);
        const etag = first.headers.etag as string;
        if ((await conditional(etag)).statusCode === 304) return etag;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error("the version never settled");
    };
    const etag = await settledEtag();
    expect(etag).toMatch(/^W\//);
    // Another region has its own tag.
    expect((await get(`/api/collection/tree?include=uncollected&regionId=${PROVINCE}`)).headers.etag).not.toBe(etag);

    await db.query(`UPDATE user_species SET is_target = true WHERE user_id = $1 AND species_id = $2`, [USER, SP_A]);
    try {
      const targeted = await conditional(etag);
      expect(targeted.statusCode).toBe(200);
      expect(targeted.json().tree[0].targetCount).toBe(1);

      // A hide changes the tag too (migration 201), whether or not it hides anything shown.
      const before = await settledEtag();
      await db.query(`INSERT INTO region_species_hidden (user_id, region_id, species_id) VALUES ($1, $2, $3)`, [
        USER,
        COUNTRY,
        SP_C,
      ]);
      const hidden = await conditional(before);
      expect(hidden.statusCode).toBe(200);
      expect(hidden.headers.etag).not.toBe(before);
    } finally {
      await db.query(`DELETE FROM region_species_hidden WHERE user_id = $1`, [USER]);
      await db.query(`UPDATE user_species SET is_target = false WHERE user_id = $1`, [USER]);
    }
  }, 60000);
  it("warms the All regions tree under the tag a click asks with, and builds the same body", async () => {
    const { warmTree, clearBuiltTrees } = await import("./tree.js");
    const path = "/api/collection/tree?include=uncollected";
    clearBuiltTrees();
    // The version is database-wide, so a parallel test file can bump it: a warm-up only builds once
    // it has seen the same tag twice, and the click must land before the next bump.
    for (let attempt = 0; attempt < 20; attempt++) {
      const built = await warmTree(USER);
      if (!built) continue;
      const warm = await get(path);
      if (warm.headers.etag !== built) continue;
      expect(await warmTree(USER)).toBeNull();
      clearBuiltTrees();
      const fresh = await get(path);
      if (fresh.headers.etag !== built) continue;
      expect(warm.body).toBe(fresh.body);
      return;
    }
    throw new Error("the version never settled");
  }, 60000);
});
