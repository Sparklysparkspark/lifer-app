// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// One location undo history: placing, filing under a spot and removing each undo exactly, in
// reverse order; each user has their own; a placement over 5,000 photos is one background job.
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000a51";
const OTHER = "eeeeeeee-0000-4000-8000-000000000a52";
const SPECIES = "eeeeeeee-0000-4000-8000-000000000a53";
const REGION = "eeeeeeee-0000-4000-8000-000000000a54";
const auth = vi.hoisted(() => ({ user: "" }));

vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: auth.user, email: "history@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});

describe.skipIf(!url)("location undo history", () => {
  let app: FastifyInstance;
  let db: pg.Pool;

  const call = (method: "GET" | "POST", route: string, payload?: object, user = USER) => {
    auth.user = user;
    return app.inject({ method, url: `/api${route}`, payload });
  };
  const row = async (id: string) =>
    (
      await db.query(
        `SELECT lat, lon, region_id, location_label, location_source, location_accuracy_m FROM captures_all WHERE id = $1`,
        [id],
      )
    ).rows[0];

  async function jobDone(user = USER) {
    for (let i = 0; i < 400; i++) {
      const status = (await call("GET", "/captures/location/status", undefined, user)).json();
      if (!status.running && status.finishedAt) return status;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("the job never finished");
  }

  async function cleanup() {
    await db.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[USER, OTHER]]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.query(`DELETE FROM regions WHERE id = $1`, [REGION]);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    await cleanup();
    await db.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, 'history@test', 'x'), ($2, 'history2@test', 'x')`,
      [USER, OTHER],
    );
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, 915951, 'Historia revertens', 'Undo Owl', 'aves')`,
      [SPECIES],
    );
    await db.query(`INSERT INTO regions (id, name) VALUES ($1, 'History Bay')`, [REGION]);
    const { captureRoutes } = await import("./routes.js");
    const { savedSpotRoutes } = await import("../places/savedSpots.js");
    app = Fastify();
    await app.register(captureRoutes, { prefix: "/api" });
    await app.register(savedSpotRoutes, { prefix: "/api" });
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

  it("undoes a place, a spot apply and a remove, newest first, each exactly", async () => {
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures_all (user_id, species_id, fingerprint, lat, lon, location_source, location_accuracy_m, location_label)
       VALUES ($1, $2, 'history-1', 1.5, 2.5, 'inaturalist', 30, 'Old name') RETURNING id`,
      [USER, SPECIES],
    );
    const id = c.rows[0].id;
    const original = await row(id);

    expect((await call("POST", "/captures/coordinates", { captureIds: [id], lat: 10, lon: 20 })).statusCode).toBe(200);
    const placed = await row(id);
    const spot = (
      await call("POST", "/saved-spots", { name: "History pond", lat: 30, lon: 40, regionId: REGION })
    ).json();
    // The photo has its own (placed) point, which a spot keeps unless told to move it.
    expect(
      (await call("POST", `/saved-spots/${spot.id}/apply`, { captureIds: [id], moveOwnPoints: true })).statusCode,
    ).toBe(200);
    await jobDone();
    const filed = await row(id);
    expect(filed).toMatchObject({ lat: "30", lon: "40", region_id: REGION, location_label: "History pond" });
    expect((await call("POST", "/captures/coordinates", { captureIds: [id], lat: null, lon: null })).statusCode).toBe(
      200,
    );

    expect((await call("POST", "/captures/location/undo")).json()).toEqual({ restored: 1, canUndo: true });
    expect(await row(id)).toEqual(filed);
    expect((await call("POST", "/captures/location/undo")).json()).toEqual({ restored: 1, canUndo: true });
    expect(await row(id)).toEqual(placed);
    expect((await call("POST", "/captures/location/undo")).json()).toEqual({ restored: 1, canUndo: false });
    expect(await row(id)).toEqual(original);
    expect((await call("POST", "/captures/location/undo")).json()).toEqual({ restored: 0, canUndo: false });
  });

  it("keeps each user's history apart", async () => {
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures_all (user_id, species_id, fingerprint) VALUES ($1, $2, 'history-other') RETURNING id`,
      [OTHER, SPECIES],
    );
    await call("POST", "/captures/coordinates", { captureIds: [c.rows[0].id], lat: 1, lon: 1 }, OTHER);
    expect((await call("POST", "/captures/location/undo")).json()).toEqual({ restored: 0, canUndo: false });
    expect((await call("POST", "/captures/location/undo", undefined, OTHER)).json()).toMatchObject({ restored: 1 });
  });

  it("places over 5,000 photos as one background job with one undo", async () => {
    const res = await db.query<{ id: string }>(
      `INSERT INTO captures_all (user_id, species_id, fingerprint)
       SELECT $1, $2, 'history-big-' || i FROM generate_series(1, 6000) i RETURNING id`,
      [USER, SPECIES],
    );
    const ids = res.rows.map((r) => r.id);
    const started = await call("POST", "/captures/coordinates", { captureIds: ids, lat: 7, lon: 8 });
    expect(started.json()).toEqual({ updated: 0, background: true });
    const status = await jobDone();
    expect(status.result).toEqual({ applied: 6000, spotName: null });
    expect(status.canUndo).toBe(true);
    expect((await call("POST", "/captures/location/undo")).json()).toEqual({ restored: 6000, canUndo: false });
    const left = await db.query(`SELECT count(*)::int AS n FROM captures_all WHERE id = ANY($1) AND lat IS NOT NULL`, [
      ids,
    ]);
    expect(left.rows[0].n).toBe(0);
  }, 60_000);
});
