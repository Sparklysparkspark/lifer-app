// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Saved spots: create, apply to photos as one background job, undo, nearby suggestions, and the
// sync tracking (a version on every change, a tombstone on delete).
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000911";
const SPECIES = "eeeeeeee-0000-4000-8000-000000000912";

vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: USER, email: "spots@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});

describe.skipIf(!url)("saved spots", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  const captureIds: string[] = [];

  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", route: string, payload?: object) =>
    app.inject({ method, url: `/api${route}`, payload });

  async function applyDone() {
    for (let i = 0; i < 100; i++) {
      const status = (await call("GET", "/captures/location/status")).json();
      if (!status.running && status.finishedAt) return status;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("apply never finished");
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { savedSpotRoutes } = await import("./savedSpots.js");
    const { locationRoutes } = await import("../captures/locationHistory.js");
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.query(`DELETE FROM sync_tombstones WHERE user_id = $1`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'spots@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, 915911, 'Spotia alba', 'Spot Bird', 'aves')`,
      [SPECIES],
    );
    for (let i = 0; i < 5; i++) {
      const c = await db.query<{ id: string }>(
        // Three have coordinates at the pond, two have none.
        `INSERT INTO captures_all (user_id, species_id, fingerprint, lat, lon) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [USER, SPECIES, `spot-${i}`, i < 3 ? 49.1 : null, i < 3 ? -123.1 : null],
      );
      captureIds.push(c.rows[0].id);
    }
    app = Fastify();
    await app.register(savedSpotRoutes, { prefix: "/api" });
    await app.register(locationRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
      await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
      await db.query(`DELETE FROM sync_tombstones WHERE user_id = $1`, [USER]);
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("creates, lists and refuses a duplicate name", async () => {
    const made = await call("POST", "/saved-spots", { name: "Reifel pond", lat: 49.1, lon: -123.1 });
    expect(made.statusCode).toBe(200);
    // Not filed under it yet, but the three photos at the pond are inside it.
    expect(made.json()).toMatchObject({ name: "Reifel pond", geoprivacy: "open", photoCount: 3 });
    expect((await call("POST", "/saved-spots", { name: "reifel POND", lat: 1, lon: 1 })).statusCode).toBe(409);
    expect((await call("GET", "/saved-spots")).json().spots).toHaveLength(1);
  });

  it("offers nearby photos, applies the spot as a job, and undoes it", async () => {
    const [spot] = (await call("GET", "/saved-spots")).json().spots;
    const near = (await call("GET", "/saved-spots/suggestions")).json();
    expect(near.suggestions).toEqual([{ spotId: spot.id, name: "Reifel pond", photoCount: 3 }]);

    const started = await call("POST", `/saved-spots/${spot.id}/apply`, { captureIds });
    expect(started.statusCode).toBe(200);
    const status = await applyDone();
    expect(status.result).toEqual({ applied: 5, spotName: "Reifel pond" });
    expect(status.canUndo).toBe(true);
    const after = await db.query(
      `SELECT count(*)::int AS n FROM captures WHERE user_id = $1 AND location_label = 'Reifel pond' AND lat IS NOT NULL`,
      [USER],
    );
    expect(after.rows[0].n).toBe(5);
    expect((await call("GET", "/saved-spots")).json().spots[0].photoCount).toBe(5);

    expect((await call("POST", "/captures/location/undo")).json()).toEqual({ restored: 5, canUndo: false });
    const undone = await db.query(
      `SELECT count(*)::int AS n FROM captures WHERE user_id = $1 AND lat IS NULL AND location_label IS NULL`,
      [USER],
    );
    expect(undone.rows[0].n).toBe(2);
  });

  it("needs exactly one source of photos", async () => {
    const [spot] = (await call("GET", "/saved-spots")).json().spots;
    expect((await call("POST", `/saved-spots/${spot.id}/apply`, {})).statusCode).toBe(400);
    expect((await call("POST", `/saved-spots/${spot.id}/apply`, { nearby: true, captureIds })).statusCode).toBe(400);
  });

  it("keeps camera GPS under a spot, gives photos without a point its centre, and undoes both", async () => {
    const [spot] = (await call("GET", "/saved-spots")).json().spots;
    // Applied in the test above, so it has been used.
    expect(spot).toMatchObject({ radiusM: 100, origin: "map", lastUsedAt: expect.any(String) });
    const gps = await db.query<{ id: string }>(
      `INSERT INTO captures_all (user_id, species_id, fingerprint, lat, lon) VALUES ($1, $2, 'spot-gps', 49.1004, -123.1) RETURNING id`,
      [USER, SPECIES],
    );
    const ids = [gps.rows[0].id, captureIds[4]];
    const before = await db.query(`SELECT updated_at FROM saved_spots WHERE id = $1`, [spot.id]);
    expect((await call("POST", `/saved-spots/${spot.id}/apply`, { captureIds: ids })).statusCode).toBe(200);
    await applyDone();
    const rows = await db.query(
      `SELECT id, lat::float8 AS lat, location_label, location_source, location_accuracy_m::int AS acc
       FROM captures WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r]));
    expect(byId.get(ids[0])).toMatchObject({ lat: 49.1004, location_label: "Reifel pond", location_source: null });
    expect(byId.get(ids[1])).toMatchObject({ lat: 49.1, location_source: "spot", acc: 100 });
    // Using a spot isn't an edit worth syncing.
    const used = await db.query(`SELECT updated_at, last_used_at FROM saved_spots WHERE id = $1`, [spot.id]);
    expect(used.rows[0].last_used_at).not.toBeNull();
    expect(used.rows[0].updated_at.getTime()).toBe(before.rows[0].updated_at.getTime());

    await call("POST", "/captures/location/undo");
    const undone = await db.query(`SELECT location_source, lat FROM captures WHERE id = $1`, [ids[1]]);
    expect(undone.rows[0]).toEqual({ location_source: null, lat: null });
    await db.query(`DELETE FROM captures_all WHERE id = $1`, [ids[0]]);
  });

  it("counts photos far from the spot before filing them", async () => {
    const [spot] = (await call("GET", "/saved-spots")).json().spots;
    const far = await db.query<{ id: string }>(
      `INSERT INTO captures_all (user_id, species_id, fingerprint, lat, lon) VALUES ($1, $2, 'spot-far', 49.46, -123.1) RETURNING id`,
      [USER, SPECIES],
    );
    const res = await call("POST", `/saved-spots/${spot.id}/far`, { captureIds: [far.rows[0].id, captureIds[0]] });
    expect(res.json()).toEqual({ count: 1, km: 40 });
    await db.query(`DELETE FROM captures_all WHERE id = $1`, [far.rows[0].id]);
  });

  it("still sends a renamed spot's photos obscured, and renames them too when asked", async () => {
    const [spot] = (await call("GET", "/saved-spots")).json().spots;
    const { placeForSend } = await import("./placePrivacy.js");
    await call("POST", `/saved-spots/${spot.id}/apply`, { captureIds: captureIds.slice(0, 3) });
    await applyDone();
    await call("PATCH", `/saved-spots/${spot.id}`, { geoprivacy: "obscured", name: "Reifel north pond" });
    // The photos still say "Reifel pond"; their points are inside the renamed spot.
    const sent = await placeForSend(USER, captureIds.slice(0, 3), captureIds[0], "Reifel pond, BC", "BC");
    expect(sent.geoprivacy).toBe("obscured");
    expect(sent.placeGuess).not.toContain("Reifel");

    await call("PATCH", `/saved-spots/${spot.id}`, { name: "Reifel pond" });
    const back = await call("PATCH", `/saved-spots/${spot.id}`, { name: "Reifel marsh", renamePhotos: true });
    expect(back.json().relabelled).toBe(3);
    const labels = await db.query(`SELECT DISTINCT location_label FROM captures WHERE id = ANY($1::uuid[])`, [
      captureIds.slice(0, 3),
    ]);
    expect(labels.rows).toEqual([{ location_label: "Reifel marsh" }]);
    await call("POST", "/captures/location/undo");
    const undone = await db.query(`SELECT DISTINCT location_label FROM captures WHERE id = ANY($1::uuid[])`, [
      captureIds.slice(0, 3),
    ]);
    expect(undone.rows).toEqual([{ location_label: "Reifel pond" }]);
    await call("PATCH", `/saved-spots/${spot.id}`, { name: "Reifel pond", geoprivacy: "open" });
    await call("POST", "/captures/location/undo");
  });

  it("works the locality out from the region and keeps a typed one", async () => {
    const [spot] = (await call("GET", "/saved-spots")).json().spots;
    const typed = await call("PATCH", `/saved-spots/${spot.id}`, {
      locality: "Ladner, BC",
      radiusM: 250,
      notes: "Gate",
    });
    expect(typed.json()).toMatchObject({ locality: "Ladner, BC", localitySource: "user", radiusM: 250, notes: "Gate" });
    const moved = await call("PATCH", `/saved-spots/${spot.id}`, { lat: 49.1, lon: -123.1 });
    expect(moved.json()).toMatchObject({ locality: "Ladner, BC", localitySource: "user" });
    const cleared = await call("PATCH", `/saved-spots/${spot.id}`, { locality: null });
    expect(cleared.json().localitySource === null || cleared.json().localitySource === "region").toBe(true);
    expect((await call("PATCH", `/saved-spots/${spot.id}`, { radiusM: 10 })).statusCode).toBe(400);
  });

  it("is tracked for sync: a version on edit and a tombstone on delete", async () => {
    const [spot] = (await call("GET", "/saved-spots")).json().spots;
    const { listLibraryChanges, FIRST_LIBRARY_CURSOR } = await import("../sync/library.js");
    const { pool } = await import("@lifer/core/db.js");
    const page = await listLibraryChanges(pool, USER, "savedSpots", FIRST_LIBRARY_CURSOR, 50);
    expect(page.items).toMatchObject([
      { id: spot.id, name: "Reifel pond", geoprivacy: "open", radiusM: 250, notes: "Gate", origin: "map" },
    ]);
    const before = await db.query(`SELECT updated_at FROM saved_spots WHERE id = $1`, [spot.id]);
    await call("PATCH", `/saved-spots/${spot.id}`, { geoprivacy: "obscured" });
    const after = await db.query(`SELECT updated_at, geoprivacy FROM saved_spots WHERE id = $1`, [spot.id]);
    expect(after.rows[0].geoprivacy).toBe("obscured");
    expect(after.rows[0].updated_at.getTime()).toBeGreaterThan(before.rows[0].updated_at.getTime());
    expect((await call("DELETE", `/saved-spots/${spot.id}`)).statusCode).toBe(200);
    const tomb = await db.query(`SELECT ref FROM sync_tombstones WHERE user_id = $1 AND kind = 'saved_spot'`, [USER]);
    expect(tomb.rows).toEqual([{ ref: spot.id }]);
    const gone = await listLibraryChanges(pool, USER, "savedSpots", FIRST_LIBRARY_CURSOR, 50);
    expect(gone.purged.map((p) => p.ref)).toEqual([spot.id]);
  });
});
