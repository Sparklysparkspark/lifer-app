// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000c01";

vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: USER, email: "hints@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});

describe.skipIf(!url)("send hints", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let species: string;
  const photo = async (lat: number | null, lon: number | null, label: string | null = null) =>
    (
      await db.query<{ id: string }>(
        `INSERT INTO captures_all (user_id, species_id, fingerprint, lat, lon, location_label)
         VALUES ($1, $2, gen_random_uuid()::text, $3, $4, $5) RETURNING id`,
        [USER, species, lat, lon, label],
      )
    ).rows[0].id;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { sendHintRoutes } = await import("./sendHints.js");
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'hints@test', 'x')`, [USER]);
    species = (await db.query<{ id: string }>(`SELECT id FROM species LIMIT 1`)).rows[0].id;
    await db.query(
      `INSERT INTO saved_spots (user_id, name, lat, lon, radius_m, geoprivacy) VALUES
         ($1, 'Zzhint pond', 10, 20, 100, 'obscured'),
         ($1, 'Zzhint marsh', 11, 20, 100, 'open')`,
      [USER],
    );
    app = Fastify();
    await app.register(sendHintRoutes, { prefix: "/api" });
    await app.ready();
  });
  afterAll(async () => {
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await app.close();
    await db.end();
  });

  const hints = async (captureIds: string[]) =>
    (await app.inject({ method: "POST", url: "/api/places/send-hints", payload: { captureIds } })).json();

  it("names the photos without a point and recognises the place a located one is at", async () => {
    const none = await photo(null, null);
    // About 110 m from the pond's centre: inside a small place's 150 m reach.
    const near = await photo(10.001, 20);
    const res = await hints([none, near]);
    expect(res.withoutLocation).toEqual([none]);
    expect(res.point).toEqual({ lat: 10.001, lon: 20 });
    expect(res.looksLike).toMatchObject({ name: "Zzhint pond" });
    // Not inside the 100 m radius, so the send isn't obscured yet.
    expect(res.geoprivacy).toBeNull();
  });

  it("gives the privacy the send will use, and stops offering a place once filed under one", async () => {
    const filed = await photo(null, null, "zzhint POND");
    const res = await hints([filed]);
    expect(res.geoprivacy).toBe("obscured");
    expect(res.looksLike).toBeNull();
    expect(res.point).toBeNull();
  });

  it("offers nothing far from every place", async () => {
    const far = await photo(30, 30);
    const res = await hints([far]);
    expect(res).toMatchObject({ withoutLocation: [], looksLike: null, geoprivacy: null });
  });
});
