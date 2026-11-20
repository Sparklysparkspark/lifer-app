// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// A big eBird history: 4,000 checklists import, re-import, page and match against a year-long trip
// quickly and without losing or repeating any.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000001901";
const SPECIES = "eeeeeeee-0000-4000-8000-000000001902";
const TRIP = "eeeeeeee-0000-4000-8000-000000001903";
const TOKEN = "lifer_test_ebird_scale_1901";
const COUNT = 4000;
const PHOTOS = 1000;

const HEADER =
  "Submission ID,Common Name,Scientific Name,Taxonomic Order,Count,State/Province,County,Location ID,Location,Latitude,Longitude,Date,Time,Protocol,Duration (Min),All Obs Reported";
const BIRDS = ["Ardea herodias", "Anas platyrhynchos", "Poecile atricapillus"];

/** Eleven counts a day through 2024, an hour apart from 07:00, three species each. */
function checklistAt(i: number): { subId: string; day: string; hour: number } {
  const day = new Date(Date.UTC(2024, 0, 1) + Math.floor(i / 11) * 86_400_000).toISOString().slice(0, 10);
  return { subId: `S${String(i).padStart(7, "0")}`, day, hour: 7 + (i % 11) };
}
function bigCsv(): string {
  const rows = [HEADER];
  for (let i = 0; i < COUNT; i++) {
    const { subId, day, hour } = checklistAt(i);
    const time = `${String(hour > 12 ? hour - 12 : hour).padStart(2, "0")}:00 ${hour >= 12 ? "PM" : "AM"}`;
    for (const sci of BIRDS)
      rows.push(
        `${subId},Bird,${sci},1,1,BC,Metro,L${i},"Pond ${i}, north side",49.1,-123.1,${day},${time},Traveling,45,1`,
      );
  }
  return rows.join("\n");
}

describe.skipIf(!url)("ebird with 4,000 checklists", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let cookieName: string;
  const csv = bigCsv();

  const call = (method: "GET" | "POST", route: string, payload?: object) =>
    app.inject({ method, url: route, payload, cookies: { [cookieName]: TOKEN } });
  const upload = (text: string) => {
    const boundary = "----ebirdscale";
    const payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="MyEBirdData.csv"\r\nContent-Type: text/csv\r\n\r\n${text}\r\n--${boundary}--\r\n`;
    return app.inject({
      method: "POST",
      url: "/api/ebird/import",
      payload,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      cookies: { [cookieName]: TOKEN },
    });
  };
  const timed = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    const result = await run();
    console.log(`[ebird scale] ${label}: ${Math.round(performance.now() - started)} ms`);
    return result;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-ebird-scale-"));
    // A runaway query fails the test instead of holding the pool (and every later suite) for minutes.
    process.env.DATABASE_URL = `${url}${url!.includes("?") ? "&" : "?"}options=-c%20statement_timeout%3D15000`;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { ebirdRoutes } = await import("./routes.js");
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'ebird-scale@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, 915901, 'Ardea herodias', 'Great Blue Heron', 'aves')`,
      [SPECIES],
    );
    await db.query(
      `INSERT INTO trips (id, user_id, name, source_folder, destination_folder, start_date, end_date)
       VALUES ($1, $2, 'Big year', '/s', '/d', '2024-01-01', '2024-12-31')`,
      [TRIP, USER],
    );
    // A photo ten minutes into every fourth checklist.
    await db.query(
      `INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at, trip_id, lat, lon)
       SELECT $1, $2, 'eb-scale-' || g, $3::timestamptz + (g / 11) * interval '1 day' + (g % 11) * interval '1 hour', $4, 49.1, -123.1
       FROM generate_series(0, ${PHOTOS * 4 - 1}, 4) AS g`,
      [USER, SPECIES, "2024-01-01T07:10:00Z", TRIP],
    );
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
  }, 60_000);

  it("imports 4,000 checklists once, and again without duplicates", async () => {
    const first = await timed("import 4,000", () => upload(csv));
    expect(first.json()).toEqual({ checklists: COUNT, added: COUNT, skipped: [] });
    const again = await timed("re-import 4,000", () => upload(csv));
    expect(again.json()).toEqual({ checklists: COUNT, added: 0, skipped: [] });
    const stored = await db.query<{ n: number; species: number }>(
      `SELECT count(*)::int AS n, sum(cardinality(species))::int AS species FROM ebird_checklists WHERE user_id = $1`,
      [USER],
    );
    expect(stored.rows[0]).toEqual({ n: COUNT, species: COUNT * BIRDS.length });
  }, 60_000);

  it("pages through every checklist once, newest first", async () => {
    const seen: string[] = [];
    await timed("page all 4,000", async () => {
      for (let offset = 0; ;) {
        const page = (await call("GET", `/api/ebird/checklists?offset=${offset}`)).json();
        expect(page.total).toBe(COUNT);
        if (page.items.length === 0) break;
        seen.push(...page.items.map((c: { subId: string }) => c.subId));
        offset += page.items.length;
      }
    });
    expect(seen).toHaveLength(COUNT);
    expect(new Set(seen).size).toBe(COUNT);
    expect(seen[0]).toBe(checklistAt(COUNT - 1).subId);
    expect(seen.at(-1)).toBe(checklistAt(0).subId);
  });

  it("matches 1,000 photos against 4,000 checklists", async () => {
    const res = await timed("match 1,000 photos", () =>
      call("POST", `/api/trips/${TRIP}/ebird-match`, { offsetMinutes: 0 }),
    );
    expect(res.json()).toEqual({ suggested: PHOTOS });
    const links = await db.query<{ sub_id: string; n: number }>(
      `SELECT l.sub_id, count(*)::int AS n FROM capture_ebird_checklists l WHERE l.user_id = $1 GROUP BY l.sub_id`,
      [USER],
    );
    expect(links.rows).toHaveLength(PHOTOS);
    expect(links.rows.every((r) => r.n === 1 && Number(r.sub_id.slice(1)) % 4 === 0)).toBe(true);
  }, 60_000);

  // Statistics as autovacuum leaves them shortly after a big import.
  const analyze = () => db.query(`ANALYZE ebird_checklists; ANALYZE capture_ebird_checklists; ANALYZE captures_all`);

  it("answers a trip with 4,000 checklists quickly", async () => {
    await analyze();
    const started = performance.now();
    const res = await timed("trip checklists", () => call("GET", `/api/trips/${TRIP}/ebird-checklists`));
    expect(performance.now() - started).toBeLessThan(2000);
    const lists = res.json().checklists as Array<{ subId: string; suggested: number }>;
    expect(lists[0].subId).toBe(checklistAt(0).subId);
    expect(lists.every((c, i) => c.suggested === (i % 4 === 0 ? 1 : 0))).toBe(true);
  }, 30_000);

  // Known gap (I-07): the trip's list stops at 500 with no way to see the rest.
  it.fails(
    "lists all of a trip's 4,000 checklists",
    async () => {
      await analyze();
      const res = await call("GET", `/api/trips/${TRIP}/ebird-checklists`);
      const lists = res.json().checklists as Array<{ subId: string; suggested: number }>;
      expect(lists).toHaveLength(COUNT);
      expect(lists.filter((c) => c.suggested === 1)).toHaveLength(PHOTOS);
    },
    30_000,
  );
});
