// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Suggested identifications count on the life list with a flag, group into encounters, and a
// confirmation or the user's own choice is never overwritten by a later suggestion.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const OWNER = "eeeeeeee-0000-4000-8000-000000000701";
const SP_SUGGESTED = "eeeeeeee-0000-4000-8000-00000000070a";
const SP_CHOSEN = "eeeeeeee-0000-4000-8000-00000000070b";
const SP_OTHER = "eeeeeeee-0000-4000-8000-00000000070c";
const REGION = "eeeeeeee-0000-4000-8000-00000000070f";
const TOKEN = "lifer_test_identification_owner_701";

describe.skipIf(!url)("suggested identifications", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let cookieName: string;
  const ids: string[] = [];

  const call = (method: "GET" | "POST", route: string, payload?: unknown) =>
    app.inject({ method, url: route, payload: payload as object, cookies: { [cookieName]: TOKEN } });

  async function cleanup() {
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [OWNER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [OWNER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [OWNER]);
    await db.query(`DELETE FROM region_species WHERE region_id = $1`, [REGION]);
    await db.query(`DELETE FROM regions WHERE id = $1`, [REGION]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[SP_SUGGESTED, SP_CHOSEN, SP_OTHER]]);
  }

  async function capture(speciesId: string, state: "suggested" | "confirmed", takenAt: string, percent: number | null) {
    const res = await db.query<{ id: string }>(
      `INSERT INTO captures (user_id, species_id, fingerprint, taken_at, identification_state, suggestion_percent)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [OWNER, speciesId, `ident-${ids.length}`, takenAt, state, percent],
    );
    ids.push(res.rows[0].id);
    return res.rows[0].id;
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-identification-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { integrationRoutes } = await import("../integrations/routes.js");
    const { identificationRoutes } = await import("./identification.js");

    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'ident@test', 'x')`, [OWNER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      OWNER,
    ]);
    for (const [id, key, name] of [
      [SP_SUGGESTED, 970701, "Testus suggestus"],
      [SP_CHOSEN, 970702, "Testus chosenus"],
      [SP_OTHER, 970703, "Testus otherus"],
    ] as const)
      await db.query(
        `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, $2, $3, $3, 'aves')`,
        [id, key, name],
      );
    await db.query(`INSERT INTO regions (id, name) VALUES ($1, 'Identification Test Region')`, [REGION]);
    await db.query(`INSERT INTO region_species (region_id, species_id) VALUES ($1, $2)`, [REGION, SP_SUGGESTED]);
    await capture(SP_SUGGESTED, "suggested", "2026-05-01T10:00:00Z", 92);
    await capture(SP_SUGGESTED, "suggested", "2026-05-01T10:20:00Z", 95);
    await capture(SP_SUGGESTED, "suggested", "2026-05-03T10:00:00Z", 91);
    await capture(SP_CHOSEN, "confirmed", "2026-05-02T10:00:00Z", null);
    await capture(SP_OTHER, "suggested", "2026-05-02T11:00:00Z", 90);
    await capture(SP_OTHER, "confirmed", "2026-05-02T11:05:00Z", null);
    for (const sp of [SP_SUGGESTED, SP_CHOSEN, SP_OTHER])
      await db.query(
        `INSERT INTO user_species (user_id, species_id, state, first_collected) VALUES ($1, $2, 'collected', now())`,
        [OWNER, sp],
      );

    app = Fastify();
    await app.register(cookie);
    await app.register(integrationRoutes, { prefix: "/api" });
    await app.register(identificationRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await cleanup();
      await db.end();
    }
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("counts suggested photos on the life list with a flag, and says how many", async () => {
    const list = (await call("GET", "/api/life-list")).json().species as Array<{
      speciesId: string;
      suggested: boolean;
    }>;
    const flag = (id: string) => list.find((s) => s.speciesId === id)?.suggested;
    expect([flag(SP_SUGGESTED), flag(SP_CHOSEN), flag(SP_OTHER)]).toEqual([true, false, false]);
    const summary = (await call("GET", "/api/life-list/summary")).json();
    expect(summary).toMatchObject({ photographedSpecies: 3, suggestedCount: 4, suggestedSpecies: 1 });
    const { collectionCountSql, collectionQuerySql } = await import("../collection/routes.js");
    const ids3 = [SP_SUGGESTED, SP_CHOSEN, SP_OTHER];
    const rows = (await db.query(collectionQuerySql(60), [OWNER, null, false])).rows.filter((r) =>
      ids3.includes(r.species_id),
    );
    expect(rows.filter((r) => r.suggested).map((r) => r.species_id)).toEqual([SP_SUGGESTED]);
    expect((await db.query(collectionCountSql(60), [OWNER, null, false])).rows[0].suggested).toBe("1");
  });

  it("groups suggestions into encounters, least sure first, and never lists chosen photos", async () => {
    const res = (await call("GET", "/api/identifications/suggested")).json();
    expect(res).toMatchObject({ suggestedCount: 4, confirmedCount: 2, encounterCount: 3 });
    expect((await call("GET", "/api/identifications/suggested/count")).json()).toEqual({ count: 4 });
    // SP_SUGGESTED has no confirmed photo, so its encounters come first as possible lifers.
    expect(
      res.encounters.map((e: { count: number; lowestPercent: number; possibleLifer: boolean }) => [
        e.count,
        e.lowestPercent,
        e.possibleLifer,
      ]),
    ).toEqual([
      [1, 91, true],
      [2, 92, true],
      [1, 90, false],
    ]);
    const listed = res.encounters.flatMap((e: { captureIds: string[] }) => e.captureIds);
    expect(listed).not.toContain(ids[3]);
  });

  it("refiles only suggestions, and confirming keeps the species", async () => {
    const { refileSuggested } = await import("./identification.js");
    const decision = { speciesId: SP_CHOSEN, matchPercent: 99 };
    expect(await refileSuggested(db, OWNER, ids[3], decision)).toBe(false);
    expect(await refileSuggested(db, OWNER, ids[5], decision)).toBe(false);
    expect(await refileSuggested(db, OWNER, ids[4], decision)).toBe(true);
    const confirm = await call("POST", "/api/identifications/confirm", { captureIds: [ids[0], ids[1], ids[3]] });
    expect(confirm.json()).toMatchObject({ ok: true, confirmed: 2 });
    const rows = await db.query(
      `SELECT species_id, identification_state FROM captures_all WHERE id = ANY($1) ORDER BY taken_at`,
      [[ids[0], ids[3], ids[4]]],
    );
    expect(rows.rows).toEqual([
      { species_id: SP_SUGGESTED, identification_state: "confirmed" },
      { species_id: SP_CHOSEN, identification_state: "confirmed" },
      { species_id: SP_CHOSEN, identification_state: "suggested" },
    ]);
  });

  it("files nothing for a photo with no region", async () => {
    const { proposeIdentification } = await import("./identification.js");
    expect(await proposeIdentification(OWNER, new Float32Array(768), null, null)).toBeNull();
  });

  it("files a confident match only when the region's checklist lists it", async () => {
    const { decideFiling } = await import("./identification.js");
    const top = (id: string) => [
      {
        id,
        common_name: null,
        scientific_name: "x",
        score: 0.99,
        source: "reference_photo" as const,
        confident: true,
        matchPercent: 99,
      },
    ];
    expect(await decideFiling(top(SP_SUGGESTED), REGION, db)).toEqual({ speciesId: SP_SUGGESTED, matchPercent: 99 });
    expect(await decideFiling(top(SP_CHOSEN), REGION, db)).toBeNull();
  });
});
