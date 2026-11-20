// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// GET /collection/tree: totals match /collection/count, hand-added species group under Other, CSV export.
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
const TOKEN = "lifer_test_collection_tree_b01";

describe.skipIf(!url)("collection tree", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;

  const get = (route: string) => app.inject({ method: "GET", url: route, cookies: { [cookieName]: TOKEN } });

  async function cleanup() {
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[SP_A, SP_B, SP_C]]);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { collectionRoutes } = await import("./routes.js");
    const { collectionTreeRoutes } = await import("./tree.js");

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
         ($3, 920803, 'Treeus betus', 'Beta Tree Bird', 'aves', 'Passeriformes', 'Treeidae')`,
      [SP_A, SP_B, SP_C],
    );
    await db.query(`INSERT INTO user_species (user_id, species_id, state) VALUES ($1, $2, 'seen')`, [USER, SP_C]);
    for (const sp of [SP_A, SP_B]) {
      const c = await db.query<{ id: string }>(
        `INSERT INTO captures (user_id, species_id, fingerprint, taken_at) VALUES ($1, $2, $3, now()) RETURNING id`,
        [USER, sp, `tree-${sp}`],
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
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

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
});
