// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@localhost:5432/lifer_test npx vitest run places
// Place names: the ranked list, renaming (and merging), and removing, for this user only.
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000871";
const OTHER = "eeeeeeee-0000-4000-8000-000000000872";
const SPECIES = "eeeeeeee-0000-4000-8000-000000000873";
const as = vi.hoisted(() => ({ id: "" }));

vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: as.id, email: "places@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});

interface Place {
  name: string;
  count: number;
  regionId: string | null;
  regionName: string | null;
  inRegion: boolean;
}

describe.skipIf(!url)("place names", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let country: string;
  let province: string;
  let elsewhere: string;
  let n = 0;

  async function capture(
    user: string,
    label: string | null,
    regionId: string | null,
    extra: { trashed?: boolean; hidden?: boolean } = {},
  ) {
    await db.query(
      `INSERT INTO captures_all (user_id, species_id, fingerprint, location_label, region_id, deleted_at, hidden_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        user,
        SPECIES,
        `places-${n++}`,
        label,
        regionId,
        extra.trashed ? new Date() : null,
        extra.hidden ? new Date() : null,
      ],
    );
  }

  async function cleanup() {
    await db.query(`DELETE FROM captures_all WHERE user_id = ANY($1)`, [[USER, OTHER]]);
    await db.query(`DELETE FROM users WHERE id = ANY($1)`, [[USER, OTHER]]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.query(`DELETE FROM regions WHERE name LIKE 'Zzplaces %'`);
  }

  const list = async (query = "") => {
    as.id = USER;
    const res = await app.inject({ method: "GET", url: `/api/places${query}` });
    expect(res.statusCode).toBe(200);
    return (res.json() as { places: Place[] }).places;
  };
  const post = (path: string, payload: object) => {
    as.id = USER;
    return app.inject({ method: "POST", url: `/api${path}`, payload });
  };
  const labelsOf = async (user: string, trashed = false) =>
    (
      await db.query<{ location_label: string | null }>(
        `SELECT location_label FROM captures_all WHERE user_id = $1 AND (deleted_at IS NOT NULL) = $2 ORDER BY fingerprint`,
        [user, trashed],
      )
    ).rows.map((r) => r.location_label);

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    db = new pg.Pool({ connectionString: url });
    await cleanup();
    await db.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, 'places@test', 'x'), ($2, 'places2@test', 'x')`,
      [USER, OTHER],
    );
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, 918871, 'Placea nominis', 'Place Pipit', 'aves')`,
      [SPECIES],
    );
    const region = async (name: string, parent: string | null) =>
      (
        await db.query<{ id: string }>(`INSERT INTO regions (name, parent_id) VALUES ($1, $2) RETURNING id`, [
          name,
          parent,
        ])
      ).rows[0].id;
    country = await region("Zzplaces Country", null);
    province = await region("Zzplaces Province", country);
    elsewhere = await region("Zzplaces Elsewhere", null);
    const { capturePlaceRoutes } = await import("./places.js");
    app = Fastify();
    await app.register(capturePlaceRoutes, { prefix: "/api" });
    await app.ready();
  });

  beforeEach(async () => {
    await db.query(`DELETE FROM captures_all WHERE user_id = ANY($1)`, [[USER, OTHER]]);
    // Pigeon Lake: 3 live photos, mostly in the province; Élk Island: 2, elsewhere; Lakeview: 1.
    await capture(USER, "Pigeon Lake", province);
    await capture(USER, "Pigeon Lake", province);
    await capture(USER, "Pigeon Lake", elsewhere);
    await capture(USER, "Élk Island", elsewhere);
    await capture(USER, "Élk Island", elsewhere);
    await capture(USER, "Lakeview", null);
    await capture(USER, null, province);
    await capture(USER, "Pigeon Lake", province, { trashed: true });
    await capture(USER, "Trashed Only", province, { trashed: true });
    await capture(USER, "Hidden Only", province, { hidden: true });
    await capture(OTHER, "Pigeon Lake", province);
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("lists each live name with its count and most common region, most used first", async () => {
    const places = await list();
    expect(places.map((p) => [p.name, p.count, p.regionName])).toEqual([
      ["Pigeon Lake", 3, "Zzplaces Province"],
      ["Élk Island", 2, "Zzplaces Elsewhere"],
      ["Lakeview", 1, null],
    ]);
    expect(places.every((p) => !p.inRegion)).toBe(true);
  });

  it("ranks names used inside the region first, then prefix matches", async () => {
    const inCountry = await list(`?regionId=${country}`);
    expect(inCountry.map((p) => [p.name, p.inRegion])).toEqual([
      ["Pigeon Lake", true],
      ["Élk Island", false],
      ["Lakeview", false],
    ]);
    const elsewhereFirst = await list(`?regionId=${elsewhere}`);
    expect(elsewhereFirst.map((p) => p.name)).toEqual(["Pigeon Lake", "Élk Island", "Lakeview"]);
    // "lake": Lakeview starts with it, so it beats the more used Pigeon Lake.
    expect((await list("?q=LAKE")).map((p) => p.name)).toEqual(["Lakeview", "Pigeon Lake"]);
    expect((await list("?q=elk")).map((p) => p.name)).toEqual(["Élk Island"]);
    expect((await list("?limit=1")).map((p) => p.name)).toEqual(["Pigeon Lake"]);
  });

  it("renames a name on every live photo, leaving other users and the trash alone", async () => {
    const res = await post("/places/rename", { from: " Pigeon Lake ", to: "Pigeon Lake Park" });
    expect(res.json()).toEqual({ updated: 3, movingFiles: false });
    expect((await list()).map((p) => [p.name, p.count])).toContainEqual(["Pigeon Lake Park", 3]);
    expect(await labelsOf(OTHER)).toEqual(["Pigeon Lake"]);
    expect(await labelsOf(USER, true)).toEqual(["Pigeon Lake", "Trashed Only"]);
  });

  it("merges into a name already in use", async () => {
    expect((await post("/places/rename", { from: "Lakeview", to: "Pigeon Lake" })).json()).toEqual({
      updated: 1,
      movingFiles: false,
    });
    expect((await list()).map((p) => [p.name, p.count])).toEqual([
      ["Pigeon Lake", 4],
      ["Élk Island", 2],
    ]);
  });

  it("removes a name, keeping the photos' regions", async () => {
    expect((await post("/places/remove", { name: "Pigeon Lake" })).json()).toEqual({ updated: 3, movingFiles: false });
    const rows = await db.query<{ region_id: string | null }>(
      `SELECT region_id FROM captures WHERE user_id = $1 AND location_label IS NULL`,
      [USER],
    );
    expect(rows.rows.map((r) => r.region_id).sort()).toEqual([province, province, province, elsewhere].sort());
    expect(await labelsOf(OTHER)).toEqual(["Pigeon Lake"]);
  });

  it("renames and removes the name on hidden photos too, though the list leaves them out", async () => {
    const hiddenLabel = async () =>
      (
        await db.query<{ location_label: string | null }>(
          `SELECT location_label FROM captures_all WHERE user_id = $1 AND hidden_at IS NOT NULL`,
          [USER],
        )
      ).rows[0].location_label;
    expect((await list()).map((p) => p.name)).not.toContain("Hidden Only");
    expect((await post("/places/rename", { from: "Hidden Only", to: "Still Hidden" })).json()).toEqual({
      updated: 1,
      movingFiles: false,
    });
    expect(await hiddenLabel()).toBe("Still Hidden");
    expect((await post("/places/remove", { name: "Still Hidden" })).json()).toEqual({ updated: 1, movingFiles: false });
    expect(await hiddenLabel()).toBeNull();
    // Trashed photos keep theirs.
    expect((await post("/places/rename", { from: "Trashed Only", to: "Gone" })).json()).toEqual({
      updated: 0,
      movingFiles: false,
    });
  });

  it("refuses blank and overlong names", async () => {
    expect((await post("/places/rename", { from: "Lakeview", to: "  " })).statusCode).toBe(400);
    expect((await post("/places/remove", { name: "" })).statusCode).toBe(400);
    expect((await post("/places/remove", { name: "x".repeat(501) })).statusCode).toBe(400);
    expect((await post("/places/remove", { name: "x", extra: 1 })).statusCode).toBe(400);
  });
});
