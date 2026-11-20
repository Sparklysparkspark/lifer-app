// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Target lists: CSV preview, import, undo, rename and delete, and that removing a list never
// clears a species another list or the user's own flag still holds.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000951";
const OTHER = "eeeeeeee-0000-4000-8000-000000000952";
const TOKEN = "lifer_test_target_lists_951";
const REGION = "eeeeeeee-0000-4000-8000-00000000095f";
const SP = ["a", "b", "c", "d", "e"].map((c) => `eeeeeeee-0000-4000-8000-00000000095${c}`);
const [ALPHA, BETA, GAMMA, DELTA, EPSILON] = SP;
const BOUNDARY = "----lifer-target-boundary";

const form = (csv: string) =>
  [
    `--${BOUNDARY}`,
    'Content-Disposition: form-data; name="file"; filename="targets.csv"',
    "Content-Type: text/csv",
    "",
    csv,
    `--${BOUNDARY}--`,
    "",
  ].join("\r\n");

describe.skipIf(!url)("target list routes", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;

  const call = async (method: "GET" | "POST" | "PATCH" | "DELETE", path: string, payload?: object) =>
    app.inject({ method, url: `/api${path}`, payload, cookies: { [cookieName]: TOKEN } });
  const preview = (csv: string, regionId?: string) =>
    app.inject({
      method: "POST",
      url: `/api/target-lists/preview${regionId ? `?regionId=${regionId}` : ""}`,
      payload: form(csv),
      headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      cookies: { [cookieName]: TOKEN },
    });
  const undo = ({ listId, createdList, addedSpeciesIds, checklistSpeciesIds }: Record<string, unknown>) =>
    call("POST", "/target-lists/import/undo", { listId, createdList, addedSpeciesIds, checklistSpeciesIds });
  const targets = async () =>
    (
      await db.query<{ species_id: string }>(
        `SELECT species_id FROM user_species WHERE user_id = $1 AND is_target ORDER BY species_id`,
        [USER],
      )
    ).rows.map((r) => r.species_id);

  async function cleanup() {
    await db.query(`DELETE FROM users WHERE id = ANY($1)`, [[USER, OTHER]]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [SP]);
    await db.query(`DELETE FROM regions WHERE id = $1`, [REGION]);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { targetListRoutes } = await import("./targetLists.js");
    await cleanup();
    await db.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, 'target-lists@test', 'x'), ($2, 'target-lists-2@test', 'x')`,
      [USER, OTHER],
    );
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    const names = [
      ["Targetus alpha", "Alpha Bird"],
      ["Targetus beta", "Twin Bird"],
      ["Targetus gamma", "Twin Bird"],
      ["Targetus delta", "Delta Bird"],
      ["Targetus epsilon", "Epsilon Bird"],
    ];
    for (const [i, id] of SP.entries())
      await db.query(
        `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, $2, $3, $4, 'aves')`,
        [id, 920951 + i, names[i][0], names[i][1]],
      );
    await db.query(`INSERT INTO species_synonyms (species_id, synonym_name) VALUES ($1, 'Oldgenus betus')`, [BETA]);
    await db.query(`INSERT INTO regions (id, name, external_codes) VALUES ($1, 'Targetland', '{ZZ}')`, [REGION]);
    await db.query(`INSERT INTO region_species (region_id, species_id) VALUES ($1, $2), ($1, $3), ($1, $4)`, [
      REGION,
      ALPHA,
      BETA,
      DELTA,
    ]);
    // Delta is photographed; Epsilon was flagged by hand before any list.
    await db.query(
      `INSERT INTO user_species (user_id, species_id, state, is_target) VALUES ($1, $2, 'collected', false), ($1, $3, NULL, true)`,
      [USER, DELTA, EPSILON],
    );
    app = Fastify();
    await app.register(cookie);
    await app.register(multipart);
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

  it("previews matches by scientific name, synonym and common name, flagging the region's checklist", async () => {
    const csv =
      "Common Name,Scientific Name\n,targetus alpha\n,Oldgenus betus\nTwin Bird,\nx,Targetus delta\n,Nope nope\n";
    // The scientific column wins; an empty cell there is skipped, so Twin Bird comes from a one-column file below.
    const res = await preview(csv, REGION);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.canAddToChecklist).toBe(true);
    const byName = Object.fromEntries(body.rows.map((r: { name: string }) => [r.name, r]));
    expect(byName["targetus alpha"].status).toBe("matched");
    expect(byName["targetus alpha"].options[0]).toMatchObject({ speciesId: ALPHA, onChecklist: true, state: null });
    expect(byName["Oldgenus betus"].options.map((o: { speciesId: string }) => o.speciesId)).toEqual([BETA]);
    expect(byName["Targetus delta"].options[0].state).toBe("collected");
    expect(byName["Nope nope"]).toMatchObject({ status: "unmatched", options: [] });

    const twin = (await preview("Twin Bird\nTargetus gamma\n", REGION)).json();
    expect(twin.rows[0].status).toBe("ambiguous");
    expect(twin.rows[0].options.map((o: { speciesId: string }) => o.speciesId).sort()).toEqual([BETA, GAMMA].sort());
    expect(twin.rows[1].options[0]).toMatchObject({ speciesId: GAMMA, onChecklist: false });
  });

  it("refuses a file it can't read, in plain words", async () => {
    const res = await preview("a,b\n1,2\n");
    expect([res.statusCode, res.json().error]).toEqual([
      400,
      'The file needs a "Scientific Name" or "Common Name" column.',
    ]);
  });

  it("imports, leaves photographed species alone, and keeps targets another list or the user still holds", async () => {
    const trip = (
      await call("POST", "/target-lists/import", {
        name: "Trip",
        regionId: REGION,
        speciesIds: SP,
        addToChecklist: true,
      })
    ).json();
    expect(trip.createdList).toBe(true);
    expect(trip.leftAlone).toBe(1);
    expect([...trip.addedSpeciesIds].sort()).toEqual([ALPHA, BETA, GAMMA, EPSILON].sort());
    expect([...trip.checklistSpeciesIds].sort()).toEqual([GAMMA, EPSILON].sort());
    expect(await targets()).toEqual([ALPHA, BETA, GAMMA, EPSILON].sort());
    const delta = await db.query(`SELECT state, is_target FROM user_species WHERE user_id = $1 AND species_id = $2`, [
      USER,
      DELTA,
    ]);
    expect(delta.rows[0]).toEqual({ state: "collected", is_target: false });

    const general = (await call("POST", "/target-lists/import", { name: "General", speciesIds: [ALPHA] })).json();
    const lists = (await call("GET", "/target-lists")).json().lists;
    expect(lists.map((l: { name: string; regionName: string | null }) => [l.name, l.regionName])).toEqual([
      ["General", null],
      ["Trip", "Targetland"],
    ]);

    expect((await call("DELETE", `/target-lists/${trip.listId}`)).statusCode).toBe(200);
    expect(await targets()).toEqual([ALPHA, EPSILON].sort());
    await call("DELETE", `/target-lists/${general.listId}`);
    expect(await targets()).toEqual([EPSILON]);
  });

  it("undoes the last import, including its checklist additions", async () => {
    await db.query(`DELETE FROM region_species_user_added WHERE user_id = $1`, [USER]);
    const done = (
      await call("POST", "/target-lists/import", {
        name: "Undo me",
        regionId: REGION,
        speciesIds: [GAMMA],
        addToChecklist: true,
      })
    ).json();
    expect(await targets()).toEqual([GAMMA, EPSILON].sort());
    const res = await undo(done);
    expect(res.statusCode).toBe(200);
    expect(await targets()).toEqual([EPSILON]);
    expect((await call("GET", "/target-lists")).json().lists).toEqual([]);
    const added = await db.query(`SELECT 1 FROM region_species_user_added WHERE user_id = $1`, [USER]);
    expect(added.rowCount).toBe(0);
  });

  it("undoes an import into an existing list without removing the list", async () => {
    const list = (await call("POST", "/target-lists/import", { name: "Keep", speciesIds: [ALPHA] })).json();
    const more = (await call("POST", "/target-lists/import", { listId: list.listId, speciesIds: [BETA] })).json();
    expect(more.createdList).toBe(false);
    await undo(more);
    const lists = (await call("GET", "/target-lists")).json().lists;
    expect(lists.map((l: { speciesIds: string[] }) => l.speciesIds)).toEqual([[ALPHA]]);
    expect(await targets()).toEqual([ALPHA, EPSILON].sort());
    await call("DELETE", `/target-lists/${list.listId}`);
  });

  it("renames only the user's own list", async () => {
    const list = (await call("POST", "/target-lists/import", { name: "Old", speciesIds: [] })).json();
    expect((await call("PATCH", `/target-lists/${list.listId}`, { name: "  New name " })).statusCode).toBe(200);
    expect((await call("GET", "/target-lists")).json().lists[0].name).toBe("New name");
    const theirs = await db.query<{ id: string }>(
      `INSERT INTO target_lists (user_id, name) VALUES ($1, 'Theirs') RETURNING id`,
      [OTHER],
    );
    expect((await call("PATCH", `/target-lists/${theirs.rows[0].id}`, { name: "Mine" })).statusCode).toBe(404);
    expect((await call("DELETE", `/target-lists/${theirs.rows[0].id}`)).statusCode).toBe(404);
    expect((await call("POST", "/target-lists/import", { speciesIds: [] })).statusCode).toBe(400);
    await call("DELETE", `/target-lists/${list.listId}`);
  });
});
