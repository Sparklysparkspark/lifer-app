// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Import a CSV, match a trip's photos to its checklists, confirm, and read the photo's link back.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000941";
const SPECIES = "eeeeeeee-0000-4000-8000-000000000942";
const TRIP = "eeeeeeee-0000-4000-8000-000000000943";
const TOKEN = "lifer_test_ebird_routes_941";

const HEADER =
  "Submission ID,Common Name,Scientific Name,Taxonomic Order,Count,State/Province,County,Location ID,Location,Latitude,Longitude,Date,Time,Protocol,Duration (Min),All Obs Reported";
const CSV = [
  HEADER,
  "S100,Heron,Ardea herodias,1,1,BC,Metro,L1,Pond,49.1,-123.1,2024-05-01,07:30 AM,Traveling,60,1",
  "S101,Duck,Anas platyrhynchos,1,1,BC,Metro,L2,Lake,49.1,-123.1,2024-05-01,03:00 PM,Traveling,30,1",
].join("\n");

describe.skipIf(!url)("ebird routes", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let cookieName: string;
  let capture: string;

  const call = (method: "GET" | "POST", route: string, payload?: object) =>
    app.inject({ method, url: route, payload, cookies: { [cookieName]: TOKEN } });

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-ebird-routes-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { ebirdRoutes } = await import("./routes.js");
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'ebird-routes@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, 915941, 'Ardea herodias', 'Great Blue Heron', 'aves')`,
      [SPECIES],
    );
    await db.query(
      `INSERT INTO trips (id, user_id, name, source_folder, destination_folder, start_date, end_date)
       VALUES ($1, $2, 'Pond', '/s', '/d', '2024-05-01', '2024-05-01')`,
      [TRIP, USER],
    );
    // Camera on a clock three hours behind the local time of the count.
    capture = (
      await db.query<{ id: string }>(
        `INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at, trip_id, lat, lon)
         VALUES ($1, $2, 'eb-1', '2024-05-01T05:00:00Z', $3, 49.1, -123.1) RETURNING id`,
        [USER, SPECIES, TRIP],
      )
    ).rows[0].id;
    app = Fastify();
    await app.register(cookie);
    await app.register(multipart);
    await app.register(ebirdRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
      await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function upload(csv: string) {
    const boundary = "----ebirdtest";
    const payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="MyEBirdData.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`;
    return app.inject({
      method: "POST",
      url: "/api/ebird/import",
      payload,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      cookies: { [cookieName]: TOKEN },
    });
  }

  it("imports once, says what is wrong with another file, and re-imports without duplicating", async () => {
    expect((await upload(CSV)).json()).toEqual({ checklists: 2, added: 2, skipped: [] });
    expect((await upload(CSV)).json()).toMatchObject({ checklists: 2, added: 0 });
    const bad = await upload("a,b\n1,2");
    expect([bad.statusCode, bad.json().error]).toEqual([400, expect.stringContaining('no "Submission ID"')]);
  });

  it("suggests with the camera offset, confirms per trip, and links the photo", async () => {
    const none = await call("POST", `/api/trips/${TRIP}/ebird-match`, { offsetMinutes: 0 });
    expect(none.json()).toEqual({ suggested: 0 });
    const matched = await call("POST", `/api/trips/${TRIP}/ebird-match`, { offsetMinutes: 180 });
    expect(matched.json()).toEqual({ suggested: 1 });

    const listed = (await call("GET", `/api/trips/${TRIP}/ebird-checklists`)).json().checklists;
    expect(listed.map((c: { subId: string }) => c.subId)).toEqual(["S100", "S101"]);
    expect(listed[0]).toMatchObject({ suggested: 1, confirmed: 0, url: "https://ebird.org/checklist/S100" });
    expect((await call("GET", `/api/captures/${capture}/ebird`)).json().checklists).toEqual([]);

    expect((await call("POST", `/api/trips/${TRIP}/ebird-checklists/S100/confirm`)).json()).toEqual({ changed: 1 });
    expect((await call("GET", `/api/captures/${capture}/ebird`)).json().checklists).toEqual([
      { subId: "S100", location: "Pond", url: "https://ebird.org/checklist/S100" },
    ]);
    // A later match leaves the confirmed link alone.
    await call("POST", `/api/trips/${TRIP}/ebird-match`, { offsetMinutes: 0 });
    expect((await call("GET", `/api/captures/${capture}/ebird`)).json().checklists).toHaveLength(1);
  });
});
