// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Target a group: a group word or Latin name to the region's checklist species in it, leaving
// photographed and archived species out, onto a new or existing list, with the import's Undo.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000961";
const TOKEN = "lifer_test_target_groups_961";
const REGION = "eeeeeeee-0000-4000-8000-00000000096f";
const CHILD = "eeeeeeee-0000-4000-8000-00000000096e";
const SP = ["a", "b", "c", "d", "e", "f"].map((c) => `eeeeeeee-0000-4000-8000-00000000096${c}`);
const [HAWK, OWL, PHOTOGRAPHED_OWL, ARCHIVED_HAWK, SPARROW, ELSEWHERE_OWL] = SP;

describe.skipIf(!url)("target a group", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;

  const call = async (method: "GET" | "POST", path: string, payload?: object) =>
    app.inject({ method, url: `/api${path}`, payload, cookies: { [cookieName]: TOKEN } });
  const targets = async () =>
    (
      await db.query<{ species_id: string }>(
        `SELECT species_id FROM user_species WHERE user_id = $1 AND is_target ORDER BY species_id`,
        [USER],
      )
    ).rows.map((r) => r.species_id);

  async function cleanup() {
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [SP]);
    await db.query(`DELETE FROM regions WHERE id = ANY($1)`, [[CHILD, REGION]]);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { targetGroupRoutes } = await import("./targetGroups.js");
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'target-groups@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    const rows: [string, string, string, string, string][] = [
      [HAWK, "Zzgroup hawk", "Zz Hawk", "Accipitriformes", "Accipitridae"],
      [OWL, "Zzgroup owl", "Zz Owl", "Strigiformes", "Strigidae"],
      [PHOTOGRAPHED_OWL, "Zzgroup owl2", "Zz Owl Two", "Strigiformes", "Strigidae"],
      [ARCHIVED_HAWK, "Zzgroup hawk2", "Zz Hawk Two", "Accipitriformes", "Accipitridae"],
      [SPARROW, "Zzgroup sparrow", "Zz Sparrow", "Passeriformes", "Passerellidae"],
      [ELSEWHERE_OWL, "Zzgroup owl3", "Zz Owl Three", "Strigiformes", "Strigidae"],
    ];
    for (const [i, [id, sci, common, order, family]] of rows.entries())
      await db.query(
        `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class, taxon_order, family)
         VALUES ($1, $2, $3, $4, 'aves', $5, $6)`,
        [id, 930961 + i, sci, common, order, family],
      );
    await db.query(`INSERT INTO regions (id, name, external_codes) VALUES ($1, 'Zzgroupland', '{ZG}')`, [REGION]);
    await db.query(
      `INSERT INTO regions (id, name, parent_id, external_codes) VALUES ($1, 'Zzgroup East', $2, '{ZG-E}')`,
      [CHILD, REGION],
    );
    // The owl only the province lists still counts for the country.
    await db.query(
      `INSERT INTO region_species (region_id, species_id) VALUES ($1, $2), ($1, $3), ($1, $4), ($1, $5), ($1, $6), ($7, $8)`,
      [REGION, HAWK, OWL, PHOTOGRAPHED_OWL, ARCHIVED_HAWK, SPARROW, CHILD, ELSEWHERE_OWL],
    );
    await db.query(`INSERT INTO user_species (user_id, species_id, state) VALUES ($1, $2, 'collected')`, [
      USER,
      PHOTOGRAPHED_OWL,
    ]);
    await db.query(`INSERT INTO user_archived_species (user_id, species_id) VALUES ($1, $2)`, [USER, ARCHIVED_HAWK]);
    app = Fastify();
    await app.register(cookie);
    await app.register(targetGroupRoutes, { prefix: "/api" });
    const { targetListRoutes } = await import("./targetLists.js");
    await app.register(targetListRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await cleanup();
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("previews a group word, a Latin family, and says when the catalog has no such group", async () => {
    const raptors = (await call("GET", `/collection/targets/by-group?q=Raptors&regionId=${REGION}`)).json();
    expect(raptors).toEqual({
      group: "raptors",
      count: 3,
      examples: expect.arrayContaining([expect.objectContaining({ speciesId: HAWK, commonName: "Zz Hawk" })]),
    });
    const withPhotographed = await call(
      "GET",
      `/collection/targets/by-group?q=owls&regionId=${REGION}&includePhotographed=1`,
    );
    expect(withPhotographed.json().count).toBe(3);
    expect((await call("GET", `/collection/targets/by-group?q=strigidae&regionId=${REGION}`)).json()).toMatchObject({
      group: "Strigidae",
      count: 2,
    });
    expect((await call("GET", "/collection/targets/by-group?q=owls")).json()).toEqual({
      group: "owls",
      count: null,
      examples: [],
    });
    expect((await call("GET", `/collection/targets/by-group?q=mushrooms&regionId=${REGION}`)).json().group).toBeNull();
  });

  it("targets the group on a new list, and the import's Undo takes it back", async () => {
    const res = await call("POST", "/collection/targets/by-group", { q: "owls", regionId: REGION, name: "Owls" });
    expect(res.statusCode).toBe(200);
    const done = res.json();
    expect(done.createdList).toBe(true);
    expect([...done.addedSpeciesIds].sort()).toEqual([OWL, ELSEWHERE_OWL].sort());
    expect(await targets()).toEqual([OWL, ELSEWHERE_OWL].sort());

    const more = await call("POST", "/collection/targets/by-group", {
      q: "hawks and eagles",
      regionId: REGION,
      listId: done.listId,
    });
    expect(more.json()).toMatchObject({ createdList: false, addedSpeciesIds: [HAWK] });

    await call("POST", "/target-lists/import/undo", more.json());
    expect(await targets()).toEqual([OWL, ELSEWHERE_OWL].sort());
    await call("POST", "/target-lists/import/undo", done);
    expect(await targets()).toEqual([]);
    expect((await call("GET", "/target-lists")).json().lists).toEqual([]);
  });

  it("refuses an unknown group, a missing name and someone else's list", async () => {
    const unknown = await call("POST", "/collection/targets/by-group", { q: "zzz", regionId: REGION, name: "X" });
    expect(unknown.statusCode).toBe(400);
    expect((await call("POST", "/collection/targets/by-group", { q: "owls", regionId: REGION })).statusCode).toBe(400);
    const theirs = await call("POST", "/collection/targets/by-group", {
      q: "owls",
      regionId: REGION,
      listId: "00000000-0000-4000-8000-000000000000",
    });
    expect(theirs.statusCode).toBe(404);
  });
});
